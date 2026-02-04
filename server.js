import express from 'express';
import { createServer } from 'http';
import { Server } from 'socket.io';
import fs from 'fs';
import path from 'path';
import cors from 'cors';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();
const httpServer = createServer(app);
const io = new Server(httpServer, {
    cors: {
        origin: "*",
        methods: ["GET", "POST"]
    }
});

// Middleware
app.use(cors());
app.use(express.static(path.join(__dirname, '/'))); // Serve static files
app.use(express.json());

// Database File Path
const DB_FILE = path.join(__dirname, 'db.json');

// Default Data Structure
const DEFAULT_STATE = {
    users: {}, // { "nickname": { balance: 0, role: "USER", history: [] } }
    pins: [],
    escrow: [],
    feed: []
};


// --- PERSISTENCE LOGIC START ---
// Helper: Read State
function readState() {
    try {
        if (!fs.existsSync(DB_FILE)) {
            // Init with default
            fs.writeFileSync(DB_FILE, JSON.stringify(DEFAULT_STATE, null, 2));
            return JSON.parse(JSON.stringify(DEFAULT_STATE));
        }
        const data = fs.readFileSync(DB_FILE, 'utf8');
        return JSON.parse(data);
    } catch (err) {
        console.error("Error reading DB:", err);
        return JSON.parse(JSON.stringify(DEFAULT_STATE));
    }
}

// Helper: Write State (throttled could be better, but sync for safety in this critical fix)
function writeState(state) {
    try {
        // [Safety 3] Write to temp file first then rename to prevent corruption
        const tempFile = DB_FILE + '.tmp';
        fs.writeFileSync(tempFile, JSON.stringify(state, null, 2));
        fs.renameSync(tempFile, DB_FILE);
    } catch (err) {
        console.error("Error writing DB:", err);
    }
}

// --- API IMPLEMENTATION ---

// 1. [Fix 1] User Login/Signup & Validation
// Returns user specific state
app.post('/api/login', (req, res) => {
    const { nickname, role, phone } = req.body;
    let state = readState();

    if (!state.users) state.users = {};

    // Create or Get User
    if (!state.users[nickname]) {
        // New User
        state.users[nickname] = {
            balance: (role === 'PARTNER' ? 3000 : 1000), // Bonus
            role: role || 'USER',
            phone: phone || '',
            history: []
        };
        console.log(`[New User] ${nickname} created.`);
    }

    // Sync Balance just in case
    const user = state.users[nickname];

    writeState(state);
    res.json({ success: true, user: user });
});

app.get('/api/state/:nickname', (req, res) => {
    const { nickname } = req.params;
    const state = readState();

    // [Fix 1] Return only user specific data + public data
    const user = state.users?.[nickname] || { balance: 0 };

    res.json({
        walletBalance: user.balance, // Compatibility binding
        feed: state.feed || []
    });
});

// 2. Get Pins (Claim 1: Evaporation Engine)
app.get('/api/pins', (req, res) => {
    let state = readState();
    const now = Date.now();

    // Filter expired pins (Active TTL)
    const activePins = state.pins.filter(pin => {
        const isNotSolved = pin.status !== 'SOLVED';
        const isNotExpired = new Date(pin.expiresAt).getTime() > now;
        return isNotSolved && isNotExpired;
    });

    // (Optional) Auto-delete expired from DB could go here, but filtered view is safer for now.

    res.json(activePins);
});

// 3. Create Pin (Claim 5: Escrow Lock)
app.post('/api/pins', (req, res) => {
    const { title, content, latitude, longitude, durationMinutes, type, rewardAmount, creatorName } = req.body;

    // Validation
    if (!title || !latitude || !longitude || !creatorName) {
        return res.status(400).json({ success: false, message: "Missing fields" });
    }

    let state = readState();
    let user = state.users[creatorName];

    // [Fix 1] Check User
    if (!user) {
        return res.status(401).json({ success: false, message: "User not found" });
    }

    // 2. Cost Calculation
    let cost = 0;
    if (type === 'QUESTION') {
        cost = 1000; // [Restored] Real cost for MVP economy
    } else if (type === 'LIVE') {
        cost = 0; // Free for testing (Store Sub logic placeholder)
    }

    if (user.balance < cost) {
        return res.status(400).json({ success: false, message: "Not enough points" });
    }

    // Deduct
    if (cost > 0) {
        user.balance -= cost;
        user.history.push({
            title: type === 'LIVE' ? '라이브 등록' : '질문 등록',
            amount: -cost,
            type: 'SPEND',
            date: Date.now()
        });
    }

    // 3. Create Pin
    const now = Date.now();
    const expiresAt = new Date(now + (durationMinutes * 60000)).toISOString();

    const newPin = {
        id: Date.now(),
        title,
        content: content || "",
        latitude,
        longitude,
        type: type || 'QUESTION',
        rewardAmount: rewardAmount || 0,
        createdAt: new Date(now).toISOString(),
        expiresAt,
        status: 'OPEN',
        creator: { name: creatorName, tier: 'BRONZE' } // Tier logic would go here
    };

    state.pins.unshift(newPin);
    writeState(state);

    // Broadcast
    io.emit('pinCreated', newPin);
    // [Fix] Send specific wallet update to THIS socket is handled by client polling or response
    // But we can emit to specific room if we mapped sockets. For now, simple emit.

    res.json({
        success: true,
        pin: newPin,
        balance: user.balance, // Return new balance
        meta: { matchingTriggered: true, message: "Pin Created" }
    });
});


// 3. [Fix 2] Race Condition Free Payout
app.post('/api/payout', (req, res) => {
    const { pinId, amount, runnerName } = req.body; // Requester logic handled by Pin status

    // [Safety] Lock State
    let state = readState();

    // 1. Validate Runner
    if (!state.users[runnerName]) {
        return res.status(400).json({ success: false, message: "Runner not found" });
    }

    // 2. [Critical] Find & Lock Pin
    const pinIndex = state.pins.findIndex(p => p.id == pinId);
    if (pinIndex === -1) {
        return res.status(404).json({ success: false, message: "Pin not found (deleted?)" });
    }

    const pin = state.pins[pinIndex];

    // 3. [Critical] Check Double Spending
    if (pin.status === 'SOLVED') {
        return res.status(400).json({ success: false, message: "Already Paid" });
    }

    // 4. Atomic Update
    const payoutAmount = Math.floor(amount * 0.8);
    const fee = amount - payoutAmount;

    // Credit Runner
    state.users[runnerName].balance += payoutAmount;
    state.users[runnerName].history.push({
        title: '미션 성공',
        amount: payoutAmount,
        type: 'EARN',
        date: Date.now()
    });

    // Mark Solved
    state.pins[pinIndex].status = 'SOLVED';

    // Save
    writeState(state);

    // Notify
    io.emit('payoutNotification', {
        type: 'EARN',
        amount: payoutAmount,
        fee: fee,
        runnerName: runnerName, // Client filters
        title: '미션 성공 보상'
    });

    // Remove pin from map
    io.emit('pinDeleted', pinId);

    console.log(`[Payout Safe] Pin ${pinId} Solved. Runner ${runnerName} got ${payoutAmount}`);

    res.json({ success: true, balance: state.users[runnerName].balance });
});


// API: Delete Pin (Refund logic optional, currently just delete)
app.delete('/api/pins/:id', (req, res) => {
    let state = readState();
    const pinId = parseInt(req.params.id);
    const { requesterName } = req.body; // verify owner

    // Find pin
    const pin = state.pins.find(p => p.id === pinId);
    if (!pin) return res.status(404).json({ success: false });

    // Verify Owner (Simple check)
    if (pin.creator.name !== requesterName) {
        // return res.status(403).json... skip for prototype simplicity
    }

    // [Critical] If already solved, cannot delete/refund
    if (pin.status === 'SOLVED') {
        return res.status(400).json({ success: false, message: "Cannot delete completed mission" });
    }

    // [Feature] Refund Logic
    if (pin.status === 'OPEN' && pin.type === 'QUESTION') {
        const refundAmount = 1000; // Or pin.cost if stored
        if (state.users[pin.creator.name]) {
            state.users[pin.creator.name].balance += refundAmount;
            state.users[pin.creator.name].history.push({
                title: '질문 취소 환불',
                amount: refundAmount,
                type: 'REFUND',
                date: Date.now()
            });
            console.log(`[Refund] User ${pin.creator.name} refunded ${refundAmount} BP`);
        }
    }

    // Delete
    state.pins = state.pins.filter(p => p.id !== pinId);
    writeState(state);

    io.emit('pinDeleted', pinId);
    res.json({ success: true });
});

// Socket Logic
io.on('connection', (socket) => {
    console.log('User connected:', socket.id);

    // We could implement "Login" over socket here to map socket.id -> nickname
    socket.on('join', (nickname) => {
        socket.nickname = nickname;
        console.log(`Socket ${socket.id} joined as ${nickname}`);
    });

    socket.on('updateLocation', (data) => {
        socket.broadcast.emit('userMoved', data);
    });

    socket.on('sendChat', (data) => {
        socket.broadcast.emit('receiveChat', data);
    });

    socket.on('updateStatus', (data) => {
        socket.broadcast.emit('statusChanged', data);
    });

    socket.on('disconnect', () => {
        // cleanup if needed
    });
});

const PORT = 4173;
httpServer.listen(PORT, '0.0.0.0', () => {
    console.log(`Server running on http://0.0.0.0:${PORT}`);
});
