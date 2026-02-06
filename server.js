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
        methods: ["GET", "POST", "DELETE"]
    }
});

// Middleware
app.use(cors());
app.use(express.static(path.join(__dirname, '/'))); 
app.use(express.json());

// Database File Path
const DB_FILE = path.join(__dirname, 'db.json');

// [V3] Default State (돈/지갑 삭제, 심플해진 구조)
const DEFAULT_STATE = {
    users: {}, // { "nickname": { role: "STORE" | "USER", storeName: "..." } }
    pins: [],  // { id, type, title, expiresAt, ... }
    feed: []
};

// --- PERSISTENCE LOGIC ---
function readState() {
    try {
        if (!fs.existsSync(DB_FILE)) {
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

function writeState(state) {
    try {
        const tempFile = DB_FILE + '.tmp';
        fs.writeFileSync(tempFile, JSON.stringify(state, null, 2));
        fs.renameSync(tempFile, DB_FILE);
    } catch (err) {
        console.error("Error writing DB:", err);
    }
}

// --- [V3 핵심] 증발 엔진 (Garbage Collection) ---
// 1분마다 서버가 스스로 체크해서 죽은 핀을 물리적으로 삭제함
setInterval(() => {
    let state = readState();
    const now = Date.now();
    const originalCount = state.pins.length;

    // 만료된 핀 걸러내기
    state.pins = state.pins.filter(pin => new Date(pin.expiresAt).getTime() > now);

    if (state.pins.length !== originalCount) {
        console.log(`[Evaporation Engine] Cleaned up ${originalCount - state.pins.length} expired pins.`);
        writeState(state);
        io.emit('refreshPins'); // 클라이언트들에게 "지도 다시 그려!" 명령
    }
}, 60 * 1000); // 1분 주기

// --- API IMPLEMENTATION ---

// 1. [V3] Login (역할 분리)
app.post('/api/login', (req, res) => {
    const { nickname, role, storeName } = req.body;
    let state = readState();

    if (!state.users) state.users = {};

    // 유저 정보 저장 (돈은 저장 안 함)
    state.users[nickname] = {
        role: role || 'USER', // 'STORE' or 'USER'
        storeName: storeName || '',
        joinedAt: Date.now()
    };
    
    console.log(`[Login] ${nickname} (${role}) entered.`);

    writeState(state);
    res.json({ success: true, user: state.users[nickname] });
});

// 2. Get Pins (만료된 핀은 안 보여줌)
app.get('/api/pins', (req, res) => {
    let state = readState();
    const now = Date.now();

    const activePins = state.pins.filter(pin => {
        const isNotExpired = new Date(pin.expiresAt).getTime() > now;
        return isNotExpired;
    });

    res.json(activePins);
});

// 3. [V3 핵심] Create Pin (사장님 도구)
app.post('/api/pins', (req, res) => {
    // rewardAmount 삭제, durationMinutes는 기본 30분
    const { title, content, latitude, longitude, type, creatorName } = req.body;
    
    // Validation
    if (!title || !latitude || !longitude || !creatorName) {
        return res.status(400).json({ success: false, message: "Missing fields" });
    }

    let state = readState();
    const user = state.users[creatorName];

    // 사장님 권한 체크 (STORE 타입인데 일반 유저가 시도하면 차단)
    if (type === 'STORE' && (!user || user.role !== 'STORE')) {
        return res.status(403).json({ success: false, message: "Only Store Owners can create Store Pins" });
    }

    // [V3] 1인 1핀 제한 (이미 살아있는 핀이 있으면 생성 불가 - 스팸 방지)
    if (type === 'STORE') {
        const existingPin = state.pins.find(p => p.creator.name === creatorName && new Date(p.expiresAt) > Date.now());
        if (existingPin) {
             return res.status(400).json({ success: false, message: "이미 진행 중인 이벤트가 있습니다. (1개 제한)" });
        }
    }

    // 핀 생성 (돈 차감 로직 삭제됨)
    const now = Date.now();
    const DURATION_MINUTES = 30; // 무조건 30분
    const expiresAt = new Date(now + (DURATION_MINUTES * 60000)).toISOString();

    const newPin = {
        id: Date.now(),
        title, 
        content: content || "",
        latitude,
        longitude,
        type: type || 'STORE', // 'STORE' or 'QUESTION'
        createdAt: new Date(now).toISOString(),
        expiresAt,
        creator: { name: creatorName, storeName: user?.storeName || "" }
    };

    state.pins.unshift(newPin);
    writeState(state);

    // [V3] 알림 발송: "성수베이킹 님이 갓 구운 빵 핀을 꽂았습니다!"
    io.emit('pinCreated', newPin);

    res.json({ 
        success: true, 
        pin: newPin,
        message: "Pin Created (Valid for 30 mins)" 
    });
});

// 4. Delete Pin (사장님이 직접 내리기)
app.delete('/api/pins/:id', (req, res) => {
    let state = readState();
    const pinId = parseInt(req.params.id);
    const { requesterName } = req.body; 

    const pin = state.pins.find(p => p.id === pinId);
    if (!pin) return res.status(404).json({ success: false });

    // 본인 확인
    if (pin.creator.name !== requesterName) {
         return res.status(403).json({ success: false, message: "Not your pin" });
    }

    // 환불 로직 삭제됨 -> 그냥 삭제
    state.pins = state.pins.filter(p => p.id !== pinId);
    writeState(state);

    io.emit('pinDeleted', pinId);
    res.json({ success: true });
});

// Socket Logic
io.on('connection', (socket) => {
    console.log('User connected:', socket.id);

    socket.on('join', (nickname) => {
        socket.nickname = nickname;
    });

    socket.on('disconnect', () => {
    });
});

const PORT = process.env.PORT || 4173; // Render 호환성 위해 process.env.PORT 추가
httpServer.listen(PORT, '0.0.0.0', () => {
    console.log(`Server running on port ${PORT}`);
});
