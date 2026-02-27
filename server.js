const WebSocket = require('ws');
const wss = new WebSocket.Server({ port: 8080 });
const HEARTBEAT_INTERVAL = 30000;

// Use a Map to store rooms. Key = sessionCode, Value = array of clients.
const rooms = new Map();

console.log("Session signaling server started on port 8080...");

wss.on('connection', (ws, req) => {
    // The client will connect to ws://your-server/SESSION_CODE
    const sessionCode = req.url.substring(1); // Get code from URL, remove leading '/'

    if (!sessionCode) {
        console.log("Client connected without a session code. Closing.");
        ws.close(1008, "Session code required");
        return;
    }

    console.log(`Client trying to join session: ${sessionCode}`);

    // Get or create the room for this session code
    if (!rooms.has(sessionCode)) {
        rooms.set(sessionCode, []);
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
    ws.clientId = clientId; // Attach an ID to the websocket object
    ws.sessionCode = sessionCode;

    console.log(`Client ${clientId} joined session ${sessionCode}. Room size: ${room.length}`);

    ws.on('message', message => {
        const currentRoom = rooms.get(ws.sessionCode);
        if (!currentRoom) return;

        for (const client of currentRoom) {
            if (client !== ws && client.readyState === WebSocket.OPEN) {
                client.send(message);
            }
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

            // If the room is now empty, delete it.
            if (currentRoom.length === 0) {
                rooms.delete(ws.sessionCode);
                console.log(`Session ${ws.sessionCode} was empty and has been cleared.`);
            } else {
                // If the host is still there, re-assign clientId to the remaining player
                // to ensure they are always clientId 0.
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
        }
    }
}, HEARTBEAT_INTERVAL);