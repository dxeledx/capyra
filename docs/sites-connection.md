# Fixed Relay connection

Capyra can connect to a self-hosted HTTPS Relay by making outbound signed requests from the local computer. This gives each enrolled device a stable MCP path without exposing the local management port or requiring inbound network access.

The open-source Relay implementation is in [`sites-relay/`](../sites-relay/).

## Data path

1. The Relay administrator deploys the Worker and D1 schema, then configures a random `ENROLLMENT_TOKEN` as a runtime secret.
2. In Capyra, choose “Sites fixed connection”, enter the deployed Relay homepage URL and the enrollment token.
3. Capyra generates an Ed25519 device key locally, registers the public key and receives a stable `/devices/<device-id>` path.
4. The local client polls for short-lived MCP/OAuth requests using signed messages.
5. Approved results return through the Relay; device private keys, OAuth token storage, local approvals and workspace data remain on the computer.

The enrollment token is used only for first registration and removed from local state afterward. Already enrolled devices use their own keys.

## ChatGPT setup

After the device channel is established, the local workbench shows:

- Connection name: `Capyra`
- MCP URL: `https://relay.example.com/devices/<device-id>/mcp`
- Authentication: OAuth

Add these values to a ChatGPT custom app, complete the OAuth flow, then approve the connection locally. A running Relay channel is not proof of a real ChatGPT tool call; the workbench reports those states separately.

Each ChatGPT conversation keeps its own workspace binding. Switching the local default affects new conversations only. An existing conversation can select another registered workspace without reconnecting.

## Operational boundaries

- The Relay forwards only MCP, OAuth metadata, registration, token and health routes.
- The local control console and approval APIs are never forwarded.
- Requests have body, response, queue and lifetime limits.
- A claimed request is not automatically re-executed after a disconnect.
- Device signatures bind method, path, timestamp, nonce and body hash.
- Nonces are persisted to prevent replay across Worker instances.
- Revoked devices immediately stop receiving requests.
- VPN/TUN software can still affect outbound connectivity; Capyra does not modify system routes or proxy settings.

Back up Relay deployment configuration and D1 according to the hosting provider’s supported procedure. Rotate `ENROLLMENT_TOKEN` through the provider secret store, never through source control.
