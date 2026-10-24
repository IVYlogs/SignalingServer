const { WebSocketServer, WebSocket } = require('ws');
const { randomBytes, createHash, timingSafeEqual } = require('crypto');

const PORT = Number(process.env.PORT) || 8080;
const INVITE_TTL_MS = 2 * 60 * 1000;
const SESSION_TTL_MS = 12 * 60 * 60 * 1000;
const MAX_SIGNAL_BYTES = 256 * 1024;
const MAX_SESSIONS = 10_000;
const MAX_DEVICES = 20_000;
const wss = new WebSocketServer({ port: PORT, maxPayload: MAX_SIGNAL_BYTES + 4096 });

// All registries are intentionally in memory. Phones keep their own trusted-device data.
const rooms = new Map();
const onlineDevices = new Map(); // deviceId -> WebSocket
const reconnectRequests = new Map(); // requestId -> { requester, target, pairToken, expiresAt }

function send(ws, message) {
    if (ws && ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(message));
}
function sendError(ws, message, code = 'BAD_REQUEST') { send(ws, { type: 'error', code, message }); }
function token() { return randomBytes(32).toString('base64url'); }
function id(bytes = 16) { return randomBytes(bytes).toString('base64url'); }
function hash(value) { return createHash('sha256').update(value, 'utf8').digest(); }
function safeEqual(a, b) {
    if (typeof a !== 'string' || typeof b !== 'string') return false;
    const ah = hash(a), bh = hash(b);
    return ah.length === bh.length && timingSafeEqual(ah, bh);
}
function sendRoom(room, message) { send(room.creator, message); send(room.guest, message); }
function clearSocketRoom(ws) { ws.roomId = null; ws.roomRole = null; }
function removeDevice(ws) {
    if (ws.deviceId && onlineDevices.get(ws.deviceId) === ws) onlineDevices.delete(ws.deviceId);
    ws.deviceId = null;
}
function deleteRoom(roomId, reason) {
    const room = rooms.get(roomId); if (!room) return;
    rooms.delete(roomId);
    for (const peer of [room.creator, room.guest]) {
        if (peer) { send(peer, { type: 'session-ended', reason }); clearSocketRoom(peer); }
    }
}
function leaveRoom(ws) {
    const roomId = ws.roomId; if (!roomId) return;
    const room = rooms.get(roomId); clearSocketRoom(ws); if (!room) return;
    if (ws === room.creator) { deleteRoom(roomId, 'creator-disconnected'); return; }
    if (ws === room.guest) {
        room.guest = null;
        if (room.state === 'pending') { room.state = 'waiting'; send(room.creator, { type: 'pairing-request-cancelled' }); }
        else deleteRoom(roomId, 'guest-disconnected');
    }
}
function makeRoom(creator, guest, pairToken = null) {
    const roomId = id();
    const expiresAt = Date.now() + SESSION_TTL_MS;
    const room = { creator, guest, tokenHash: null, inviteExpiresAt: null, sessionExpiresAt: expiresAt, state: 'active', requestId: null, pairToken };
    rooms.set(roomId, room);
    creator.roomId = roomId; creator.roomRole = 'creator';
    guest.roomId = roomId; guest.roomRole = 'guest';
    send(creator, { type: 'joined', room: roomId, peerPresent: false, inviteConsumed: true, expiresAt });
    send(guest, { type: 'joined', room: roomId, peerPresent: true, inviteConsumed: true, expiresAt });
    sendRoom(room, { type: 'peer-joined' });
    return roomId;
}
function cleanup() {
    const now = Date.now();
    for (const [rid, room] of rooms) {
        const expiry = room.state === 'active' ? room.sessionExpiresAt : room.inviteExpiresAt;
        if (expiry && expiry <= now) deleteRoom(rid, room.state === 'active' ? 'session-expired' : 'invite-expired');
    }
    for (const [rid, req] of reconnectRequests) {
        if (req.expiresAt <= now) {
            send(req.requester, { type: 'reconnect-failed', requestId: rid, reason: 'request-expired' });
            send(req.target, { type: 'reconnect-request-cancelled', requestId: rid });
            reconnectRequests.delete(rid);
        }
    }
}
const cleanupTimer = setInterval(cleanup, 15_000); cleanupTimer.unref();

wss.on('connection', (ws, request) => {
    ws.roomId = null; ws.roomRole = null; ws.deviceId = null; ws.deviceLabel = 'Unknown device';
    console.log(`[CONNECT] ${request.socket.remoteAddress}`);
    ws.on('error', e => console.error('[WS ERROR]', e.message));
    ws.on('message', raw => {
        let m;
        try { m = JSON.parse(raw.toString()); } catch { sendError(ws, 'Invalid JSON'); return; }
        if (!m || typeof m.type !== 'string') { sendError(ws, 'Invalid message format'); return; }

        if (m.type === 'register-device') {
            if (typeof m.deviceId !== 'string' || !/^[A-Za-z0-9_-]{20,100}$/.test(m.deviceId)) { sendError(ws, 'Invalid device ID', 'INVALID_DEVICE'); return; }
            if (onlineDevices.size >= MAX_DEVICES && !onlineDevices.has(m.deviceId)) { sendError(ws, 'Device registry is full', 'SERVER_BUSY'); return; }
            const previous = onlineDevices.get(m.deviceId);
            if (previous && previous !== ws) send(previous, { type: 'device-replaced' });
            removeDevice(ws);
            ws.deviceId = m.deviceId;
            ws.deviceLabel = typeof m.deviceLabel === 'string' ? m.deviceLabel.slice(0, 40) : 'GhostLink device';
            onlineDevices.set(ws.deviceId, ws);
            send(ws, { type: 'device-registered', deviceId: ws.deviceId });
            return;
        }

        if (m.type === 'create-invite') {
            if (ws.roomId) { sendError(ws, 'Leave your current session first', 'ALREADY_IN_SESSION'); return; }
            if (rooms.size >= MAX_SESSIONS) { sendError(ws, 'Server is busy', 'SERVER_BUSY'); return; }
            const roomId = id(); const inviteToken = token();
            const room = { creator: ws, guest: null, tokenHash: hash(inviteToken), inviteExpiresAt: Date.now() + INVITE_TTL_MS, sessionExpiresAt: null, state: 'waiting', requestId: null, pairToken: null };
            rooms.set(roomId, room); ws.roomId = roomId; ws.roomRole = 'creator';
            send(ws, { type: 'invite-created', roomId, token: inviteToken, expiresAt: room.inviteExpiresAt }); return;
        }

        if (m.type === 'join-invite') {
            if (ws.roomId) { sendError(ws, 'Already in a session', 'ALREADY_IN_SESSION'); return; }
            const room = rooms.get(m.roomId);
            if (!room || room.state !== 'waiting' || room.inviteExpiresAt <= Date.now()) { sendError(ws, 'Invitation invalid or expired', 'INVITE_EXPIRED'); return; }
            if (typeof m.token !== 'string' || !room.tokenHash || !timingSafeEqual(hash(m.token), room.tokenHash)) { sendError(ws, 'Invalid invitation secret', 'INVALID_INVITE'); return; }
            const requestId = id(); room.guest = ws; room.requestId = requestId; room.state = 'pending'; ws.roomId = m.roomId; ws.roomRole = 'guest';
            room.guestDeviceId = ws.deviceId; room.creatorDeviceId = room.creator.deviceId;
            send(room.creator, { type: 'pairing-request', requestId, deviceLabel: ws.deviceLabel });
            send(ws, { type: 'pairing-pending', message: 'Waiting for approval' }); return;
        }

        if (m.type === 'pairing-response') {
            const room = rooms.get(ws.roomId);
            if (!room || ws !== room.creator || room.state !== 'pending' || m.requestId !== room.requestId) { sendError(ws, 'No matching pairing request', 'INVALID_REQUEST'); return; }
            if (m.approved !== true) { send(room.guest, { type: 'pairing-rejected' }); deleteRoom(ws.roomId, 'pairing-rejected'); return; }
            room.tokenHash = null; room.state = 'active'; room.sessionExpiresAt = Date.now() + SESSION_TTL_MS; room.pairToken = token();
            const creatorId = room.creatorDeviceId || room.creator.deviceId || '';
            const guestId = room.guestDeviceId || room.guest.deviceId || '';
            send(room.creator, { type: 'pairing-approved', room: ws.roomId, role: 'creator', peerPresent: false, expiresAt: room.sessionExpiresAt });
            send(room.guest, { type: 'pairing-approved', room: ws.roomId, role: 'guest', peerPresent: true, expiresAt: room.sessionExpiresAt });
            send(room.creator, { type: 'trusted-device', peerDeviceId: guestId, peerLabel: room.guest.deviceLabel, pairToken: room.pairToken });
            send(room.guest, { type: 'trusted-device', peerDeviceId: creatorId, peerLabel: room.creator.deviceLabel, pairToken: room.pairToken });
            send(room.creator, { type: 'joined', room: ws.roomId, peerPresent: false, inviteConsumed: true, expiresAt: room.sessionExpiresAt });
            send(room.guest, { type: 'joined', room: ws.roomId, peerPresent: true, inviteConsumed: true, expiresAt: room.sessionExpiresAt });
            sendRoom(room, { type: 'peer-joined' }); return;
        }

        if (m.type === 'reconnect-request') {
            if (!ws.deviceId) { sendError(ws, 'Register this device first', 'DEVICE_NOT_REGISTERED'); return; }
            if (ws.roomId) { sendError(ws, 'Leave current session first', 'ALREADY_IN_SESSION'); return; }
            const targetId = m.peerDeviceId;
            const target = typeof targetId === 'string' ? onlineDevices.get(targetId) : null;
            if (!target || target.readyState !== WebSocket.OPEN) { send(ws, { type: 'reconnect-failed', reason: 'peer-offline' }); return; }
            if (!target.deviceId || target.roomId) { send(ws, { type: 'reconnect-failed', reason: 'peer-busy' }); return; }
            if (typeof m.pairToken !== 'string' || m.pairToken.length < 32) { sendError(ws, 'Invalid trusted-device credential', 'INVALID_TRUST'); return; }
            const requestId = id();
            reconnectRequests.set(requestId, { requester: ws, target, pairToken: m.pairToken, expiresAt: Date.now() + 90_000 });
            send(target, { type: 'reconnect-request', requestId, requesterDeviceId: ws.deviceId, requesterLabel: ws.deviceLabel, pairToken: m.pairToken });
            send(ws, { type: 'reconnect-pending', requestId, peerDeviceId: targetId }); return;
        }

        if (m.type === 'reconnect-response') {
            const req = reconnectRequests.get(m.requestId);
            if (!req || req.target !== ws || req.expiresAt <= Date.now()) { sendError(ws, 'No matching reconnect request', 'INVALID_REQUEST'); return; }
            reconnectRequests.delete(m.requestId);
            if (m.approved !== true) { send(req.requester, { type: 'reconnect-rejected', requestId: m.requestId }); return; }
            if (req.requester.readyState !== WebSocket.OPEN || req.requester.roomId || ws.roomId) {
                send(req.requester, { type: 'reconnect-failed', reason: 'device-unavailable' }); return;
            }
            // Client validates the pair token against its local saved trusted-device record before approval.
            makeRoom(req.requester, ws, req.pairToken);
            send(req.requester, { type: 'reconnect-approved' });
            send(ws, { type: 'reconnect-approved' });
            return;
        }

        if (m.type === 'cancel-invite') {
            const room = rooms.get(ws.roomId);
            if (!room || ws !== room.creator) { sendError(ws, 'Only creator can cancel this invitation', 'NOT_CREATOR'); return; }
            deleteRoom(ws.roomId, 'creator-cancelled'); return;
        }
        if (m.type === 'join') { sendError(ws, 'Shared room codes are disabled. Scan a one-time invitation.', 'LEGACY_JOIN_DISABLED'); return; }

        if (!['offer', 'answer', 'ice'].includes(m.type)) { sendError(ws, 'Unsupported message type', 'UNSUPPORTED_TYPE'); return; }
        const room = rooms.get(ws.roomId);
        if (!room || room.state !== 'active' || room.sessionExpiresAt <= Date.now() || !room.guest || (ws !== room.creator && ws !== room.guest)) { sendError(ws, 'Pairing has not been approved', 'NOT_AUTHORIZED'); return; }
        if (!m.data || typeof m.data !== 'object' || Array.isArray(m.data)) { sendError(ws, 'Invalid signaling payload'); return; }
        if (Buffer.byteLength(JSON.stringify(m.data), 'utf8') > MAX_SIGNAL_BYTES) { sendError(ws, 'Signaling payload too large', 'PAYLOAD_TOO_LARGE'); return; }
        send(ws === room.creator ? room.guest : room.creator, { type: m.type, data: m.data });
    });

    ws.on('close', () => {
        console.log('[DISCONNECT]');
        for (const [requestId, req] of reconnectRequests) {
            if (req.requester === ws || req.target === ws) {
                send(req.requester, { type: 'reconnect-failed', requestId, reason: 'peer-disconnected' });
                send(req.target, { type: 'reconnect-request-cancelled', requestId });
                reconnectRequests.delete(requestId);
            }
        }
        removeDevice(ws);
        leaveRoom(ws);
    });
});

wss.on('listening', () => console.log(`[START] GhostLink signaling listening on ${PORT}`));
wss.on('error', e => console.error('[SERVER ERROR]', e.message));
