const WebSocket = require('ws');
const http = require('http');
const HEARTBEAT_INTERVAL = 30000;

// Create an HTTP server so we can set TCP_NODELAY on every incoming socket
// BEFORE the WebSocket upgrade. This is the server-side equivalent of the
// setsockopt(TCP_NODELAY) call in the game client.
const server = http.createServer();
server.on('connection', (socket) => {
    socket.setNoDelay(true);  // Disable Nagle's algorithm
});

const wss = new WebSocket.Server({
    server,
    // Disable per-message compression. Our packets are tiny binary frames
    // (33 bytes for inputs). Compression adds latency (zlib has to flush)
    // and CPU cost for zero size savings on data this small.
    perMessageDeflate: false,
});

// Use a Map to store rooms. Key = sessionCode, Value = array of clients.
const rooms = new Map();

server.listen(8080, () => {
    console.log("Session signaling server started on port 8080...");
});

wss.on('connection', (ws, req) => {
    // Host connects to:   ws://server/SESSION_CODE?host
    // Client connects to:  ws://server/SESSION_CODE
    const [path, queryString] = req.url.split('?');
    const sessionCode = path.substring(1); // Remove leading '/'
    const isHost = (queryString === 'host');

    if (!sessionCode) {
        console.log("Client connected without a session code. Closing.");
        ws.close(1008, "Session code required");
        return;
    }

    console.log(`${isHost ? 'Host' : 'Client'} trying to ${isHost ? 'create' : 'join'} session: ${sessionCode}`);

    if (isHost) {
        // Host creates (or reclaims) the room
        if (!rooms.has(sessionCode)) {
            rooms.set(sessionCode, []);
        }
    } else {
        // Client MUST join an existing room — reject if no host is waiting
        if (!rooms.has(sessionCode) || rooms.get(sessionCode).length === 0) {
            console.log(`Session ${sessionCode} does not exist. Rejecting client.`);
            ws.close(4001, "Session not found");
            return;
        }
    }
    const room = rooms.get(sessionCode);

    // Don't allow more than 2 players
    if (room.length >= 2) {
        console.log(`Session ${sessionCode} is full. Closing connection.`);
        ws.close(1008, "Session is full");
        return;
    }

    // Add the new client to the room
    const clientId = room.length;
    room.push(ws);
    ws.clientId = clientId;
    ws.sessionCode = sessionCode;

    // Set up direct peer references for fastest possible relay.
    // When the second player joins, both get a direct pointer to each other.
    if (room.length === 2) {
        room[0].peer = room[1];
        room[1].peer = room[0];
    }

    console.log(`Client ${clientId} joined session ${sessionCode}. Room size: ${room.length}`);

    // Hot path — relay binary data directly to peer with zero allocation.
    // This runs 60 times per second per client during gameplay.
    ws.on('message', (message) => {
        const peer = ws.peer;
        if (peer && peer.readyState === WebSocket.OPEN) {
            peer.send(message);
        }
    });

    ws.on('close', () => {
        console.log(`Client ${ws.clientId} from session ${ws.sessionCode} disconnected.`);
        const currentRoom = rooms.get(ws.sessionCode);
        
        if (currentRoom) {
            // Remove the disconnected client from the room array.
            const index = currentRoom.indexOf(ws);
            if (index > -1) {
                currentRoom.splice(index, 1);
            }

            // Clear peer references
            if (ws.peer) {
                ws.peer.peer = null;
                ws.peer = null;
            }

            // If the room is now empty, delete it.
            if (currentRoom.length === 0) {
                rooms.delete(ws.sessionCode);
                console.log(`Session ${ws.sessionCode} was empty and has been cleared.`);
            } else {
                currentRoom[0].clientId = 0;
                console.log(`Session ${ws.sessionCode} now has ${currentRoom.length} player(s).`);
            }
        }
    });
});

//Periodic cleanup
setInterval(() => {
    for (const [code, room] of rooms) {
        const alive = room.filter(ws => ws.readyState === WebSocket.OPEN);
        if (alive.length === 0) {
            rooms.delete(code);
        } else {
            rooms.set(code, alive);
            // Clear peer references for anyone whose peer was cleaned up
            for (const ws of alive) {
                if (ws.peer && ws.peer.readyState !== WebSocket.OPEN) {
                    ws.peer = null;
                }
            }
        }
    }
}, HEARTBEAT_INTERVAL);