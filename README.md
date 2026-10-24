# GhostLink Signaling Server

A lightweight WebSocket signaling server for establishing WebRTC peer-to-peer connections between GhostY / GhostLink Android clients.

The server coordinates connection setup by relaying signaling messages between peers. WebRTC handles the actual peer connection and carries supported application data and media after connectivity is established.

**Deployment:** Render  
**Runtime:** Node.js  
**WebSocket library:** `ws`

## Table of Contents

- [Overview](#overview)
- [Responsibilities](#responsibilities)
- [Architecture](#architecture)
- [Technology Stack](#technology-stack)
- [Prerequisites](#prerequisites)
- [Local Setup](#local-setup)
- [Environment Configuration](#environment-configuration)
- [Signaling Flow](#signaling-flow)
- [WebRTC and ICE](#webrtc-and-ice)
- [Render Deployment](#render-deployment)
- [Testing](#testing)
- [Security Considerations](#security-considerations)
- [Troubleshooting](#troubleshooting)
- [Related Repository](#related-repository)
- [Contributing](#contributing)
- [License](#license)

## Overview

WebRTC enables real-time peer-to-peer communication, but it requires a signaling mechanism so that peers can exchange the information needed to establish a session.

This repository provides that signaling layer.

The server accepts WebSocket connections from clients and relays supported signaling messages, including the information required for session negotiation and ICE candidate exchange.

It is intentionally separate from the Android application so that the client and signaling infrastructure can be developed and deployed independently.

## Responsibilities

The signaling server is responsible for:

- Accepting WebSocket client connections.
- Associating clients with the appropriate session or room.
- Relaying SDP offers and answers.
- Forwarding ICE candidate information.
- Supporting the connection-establishment workflow used by the Android application.
- Handling connection closure and client disconnection.

The signaling server is **not** the WebRTC media server. It does not need to process video or audio streams to relay the negotiation messages.

The exact message types, room rules, and reconnection behavior depend on the server implementation.

## Architecture

```text
             GhostY Client A
                    |
                    | WSS
                    v
          +---------------------+
          | GhostLink Signaling |
          | Node.js + ws        |
          |                     |
          | Room/session state  |
          | SDP message relay   |
          | ICE candidate relay |
          +---------------------+
                    ^
                    | WSS
                    |
             GhostY Client B

       Once WebRTC is established:

       Client A <------ WebRTC ------> Client B

       A TURN relay may be used when
       direct peer connectivity fails.
```

The signaling server and the WebRTC communication path serve different purposes:

| Component | Responsibility |
|---|---|
| Android client | User interface, pairing, WebRTC negotiation and communication |
| WebSocket signaling server | Exchanges connection-setup information |
| STUN server | Helps discover network address candidates |
| TURN server | Relays WebRTC traffic when necessary |
| Render | Hosts the signaling service |

## Technology Stack

| Technology | Purpose |
|---|---|
| Node.js | JavaScript runtime |
| `ws` | WebSocket server implementation |
| WebSocket Secure (`wss://`) | Encrypted client-to-server signaling in production |
| WebRTC | Peer-to-peer media and data transport |
| STUN/TURN | Network traversal and relaying |
| Render | Server hosting and deployment |

## Prerequisites

- A supported Node.js version.
- npm.
- Git.
- The signaling server repository.
- Two WebRTC clients or a client and a test harness.
- Network access to the signaling endpoint.

Use the Node.js version supported by the project's dependencies.

## Local Setup

### 1. Clone the repository

```bash
git clone https://github.com/TheVivekYadav/signallingServer.git
cd signallingServer
```

### 2. Install dependencies

```bash
npm install
```

### 3. Configure the server

Review the server source and `package.json` to identify the configured port, startup script, and any required environment variables.

The application should listen on the port provided by the hosting environment when deployed to Render.

Do not assume that a particular environment variable or configuration file is supported without checking the implementation.

### 4. Start the server

```bash
npm start
```

Use the development script defined in `package.json` if one is available.

### 5. Connect a client

For local development, configure the Android client to use the server's reachable WebSocket endpoint.

For example, an Android emulator may use a host-specific address to reach a server running on the development machine. A physical device generally needs an address reachable over its network.

Use `wss://` for the deployed production endpoint.

## Environment Configuration

The deployed signaling endpoint currently used by the Android application is:

`wss://ghostlink-signaling-dwaq.onrender.com`

The server is deployed as the Render service `ghostlink-signaling`.

Before deploying or changing the service, inspect the source code for:

- The port binding behavior.
- The expected environment variables.
- The startup command.
- The supported WebSocket message format.
- The session and room management implementation.
- Any origin, authentication, or authorization checks.

Do not add environment variable names to this README until they have been verified against the actual source code.

Keep private credentials out of source control. TURN credentials belong in the relevant client or credential-provisioning configuration, not in public documentation.

## Signaling Flow

A typical WebRTC connection setup follows these steps:

1. Both clients establish WebSocket connections to the signaling server.
2. The clients associate with the same authorized session or room.
3. The initiating client creates an SDP offer.
4. The server relays the offer to the intended peer.
5. The receiving client processes the offer and creates an SDP answer.
6. The server relays the answer to the initiating peer.
7. Both peers exchange ICE candidates through the signaling channel.
8. WebRTC attempts to establish a suitable network path.
9. The peers use the negotiated connection for supported data and media communication.

The exact order of SDP and ICE messages depends on the client's candidate-gathering and signaling strategy.

### Signaling versus communication

Signaling is required to establish a session, but it is not the same as the communication channel.

Once a WebRTC DataChannel is established, its application messages travel over the WebRTC connection rather than being sent through the signaling server as ordinary WebSocket messages.

If the server is unavailable after setup, an existing peer connection may continue working, but new sessions and renegotiation may fail depending on the client's implementation.

## WebRTC and ICE

WebRTC connectivity can fail even when the signaling server is healthy.

### STUN

STUN helps a client discover public-facing address information and gather ICE candidates.

### TURN

TURN relays traffic when direct connectivity cannot be established. It may be necessary on restrictive networks, behind certain NAT configurations, or when firewall rules prevent a suitable direct path.

TURN is a separate service and may have usage costs.

### Diagnosing connection failures

When troubleshooting, inspect:

- WebSocket connection status.
- Session or room membership.
- SDP offer and answer exchange.
- ICE candidate generation and forwarding.
- ICE connection state.
- The selected ICE candidate pair.
- TURN credential validity and relay allocation.
- DataChannel open and close events.

A successful WebSocket connection confirms only that signaling connectivity exists. It does not guarantee that WebRTC can establish a media or data connection.

## Render Deployment

The project currently uses Render to host the signaling server.

### Deployment configuration

1. Open the Render dashboard.
2. Select the `ghostlink-signaling` service.
3. Confirm that the correct GitHub repository and branch are connected.
4. Set the build command to `npm install` if it matches the repository configuration.
5. Set the start command to `npm start` if that script is defined in `package.json`.
6. Confirm that the server listens on the port supplied by Render.
7. Deploy and inspect the service logs.
8. Update the Android application's signaling URL if the service endpoint changes.

### Production endpoint

```text
wss://ghostlink-signaling-dwaq.onrender.com
```

Render's free services may spin down when idle and take time to respond to a subsequent request. This can affect the initial signaling connection.

Do not treat the endpoint as permanently available without monitoring its service status.

## Testing

Test the server independently of the Android application when diagnosing signaling issues.

Recommended scenarios:

- Two clients connect successfully.
- Both clients join the intended session.
- SDP offers reach the correct peer.
- SDP answers reach the initiating peer.
- ICE candidates are forwarded correctly.
- A client disconnects during negotiation.
- A client reconnects and attempts to establish a new session.
- Multiple independent sessions do not exchange messages accidentally.
- Malformed or unexpected messages are handled safely.
- Unauthorized clients cannot impersonate another participant or join a protected session.

The final cases require explicit implementation and testing; they should not be assumed to work simply because basic signaling succeeds.

## Security Considerations

The signaling server is part of the application's security boundary.

### Transport security

Use `wss://` in production to encrypt WebSocket traffic in transit between a client and the signaling endpoint.

### Session authorization

A room identifier alone is not necessarily an authentication mechanism. The server should validate that clients are authorized to join a session and send messages to the intended peer.

### Input validation

Validate incoming messages, including message types, required fields, payload sizes, and room/session identifiers.

### Resource protection

Consider connection limits, rate limits, heartbeat handling, timeouts, and cleanup of stale sessions to reduce abuse and resource exhaustion.

### Privacy and metadata

The server may observe connection metadata, signaling message contents, timestamps, and room identifiers. SDP and ICE information can also expose network-related metadata.

Avoid logging sensitive pairing data or credentials.

### Encryption claims

The server's role in relaying signaling messages does not establish the application's complete end-to-end security model. WebRTC transport encryption alone does not prove that peer identity is independently verified or that the intended participant has been authenticated.

Before production deployment, review peer authentication, session authorization, pairing-code lifetime, and key management.

## Troubleshooting

### WebSocket connection fails

- Confirm that the service is deployed and running.
- Verify the endpoint and WebSocket scheme.
- Inspect Render logs.
- Check server port binding.
- Confirm that the client and server use compatible message formats.

### Offers or answers are not received

- Verify that both clients joined the intended room.
- Inspect the signaling message routing logic.
- Check whether the target client is still connected.
- Confirm that the client uses the message types expected by the server.

### ICE connection fails

- Confirm that ICE candidates are generated and relayed.
- Check the STUN/TURN configuration on the clients.
- Verify TURN credentials and relay connectivity.
- Test on different networks.

### Works locally but fails after deployment

- Check the deployed service logs.
- Confirm that the application uses `wss://` rather than an unreachable local address.
- Check hosting configuration and port binding.
- Account for cold starts on free hosting plans.
- Ensure that session state and client connections are handled correctly after reconnects.

## Related Repository

**Android client:** [github.com/TheVivekYadav/GhostY](https://github.com/TheVivekYadav/GhostY)

The Android client is responsible for pairing, WebRTC negotiation, the user interface, and supported messaging and media features.

## Contributing

1. Fork the repository.
2. Create a feature branch.
3. Make your changes.
4. Test signaling behavior with at least two clients.
5. Open a pull request with a description of the change and test results.

Never include production credentials, private TURN credentials, access tokens, or sensitive connection logs in pull requests.

## License

Add an appropriate `LICENSE` file before publishing the project for reuse. Until a license is selected and included, do not assume that the repository grants permission to redistribute or modify the code.
