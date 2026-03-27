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

// Use noServer mode so we can validate session codes BEFORE completing
// the WebSocket handshake. If we reject here, the client's on_open
// never fires — it goes straight to on_error/on_close, which is what
// lets the game show an error on the join screen instead of transitioning.
const wss = new WebSocket.Server({
    noServer: true,
    perMessageDeflate: false,
});

// Use a Map to store rooms. Key = sessionCode, Value = array of clients.
const rooms = new Map();

// --- Validate and gate the upgrade BEFORE the WS handshake completes ---
server.on('upgrade', (request, socket, head) => {
    const [path, queryString] = request.url.split('?');
    const sessionCode = path.substring(1);
    const isHost = (queryString === 'host');

    if (!sessionCode) {
        console.log("Upgrade rejected: no session code.");
        socket.write('HTTP/1.1 400 Bad Request\r\n\r\n');
        socket.destroy();
        return;
    }

    if (isHost) {
        // Host creates the room (or reclaims an empty one)
        if (!rooms.has(sessionCode)) {
            rooms.set(sessionCode, []);
        }
    } else {
        // Client MUST join an existing room with a host waiting
        if (!rooms.has(sessionCode) || rooms.get(sessionCode).length === 0) {
            console.log(`Upgrade rejected: session ${sessionCode} does not exist.`);
            socket.write('HTTP/1.1 404 Not Found\r\n\r\n');
            socket.destroy();
            return;
        }
    }

    const room = rooms.get(sessionCode);
    if (room.length >= 2) {
        console.log(`Upgrade rejected: session ${sessionCode} is full.`);
        socket.write('HTTP/1.1 409 Conflict\r\n\r\n');
        socket.destroy();
        return;
    }

    // Validation passed — complete the WebSocket handshake
    wss.handleUpgrade(request, socket, head, (ws) => {
        wss.emit('connection', ws, request);
    });
});

server.listen(8080, () => {
    console.log("Session signaling server started on port 8080...");
});

// --- Connection handler (only reached if upgrade was approved) ---
wss.on('connection', (ws, req) => {
    const [path, queryString] = req.url.split('?');
    const sessionCode = path.substring(1);
    const isHost = (queryString === 'host');

    const room = rooms.get(sessionCode);

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

    console.log(`${isHost ? 'Host' : 'Client'} ${clientId} joined session ${sessionCode}. Room size: ${room.length}`);

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