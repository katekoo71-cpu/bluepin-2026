// server.js (V13.5 - 경제 시스템 적용)
const express = require('express');
const http = require('http');
const socketIo = require('socket.io');
const path = require('path');
const cors = require('cors');

const app = express();
const server = http.createServer(app);
const io = socketIo(server);

app.use(cors());
app.use(express.json({ limit: '10mb' }));
app.use(express.static(__dirname));

// 임시 데이터 저장소 (서버 재시작 시 초기화)
let pins = [];
let users = [];

app.get('/', (req, res) => { res.sendFile(path.join(__dirname, 'index.html')); });

// 회원가입 (축하금 1000 BP)
app.post('/register', (req, res) => {
    const { username, password, role, storeName } = req.body;
    const existing = users.find(u => u.username === username);
    if (existing) return res.json({ success: false, message: "이미 있는 ID입니다." });

    const newUser = {
        username, password, role, 
        storeName: role === 'host' ? storeName : null,
        points: role === 'guest' ? 1000 : 0 // ★ 가입 축하금
    };
    users.push(newUser);
    res.json({ success: true, message: "가입 성공! (+1000 BP 지급)" });
});

// 로그인
app.post('/login', (req, res) => {
    const { username, password } = req.body;
    const user = users.find(u => u.username === username && u.password === password);
    if (user) {
        res.json({ success: true, role: user.role, storeName: user.storeName, points: user.points });
    } else {
        res.json({ success: false, message: "ID 또는 비번 틀림" });
    }
});

// Sound Pay (1000 BP 차감)
app.post('/use-point', (req, res) => {
    const { username } = req.body;
    const user = users.find(u => u.username === username);
    if (user && user.points >= 1000) {
        user.points -= 1000;
        res.json({ success: true, newPoints: user.points });
    } else {
        res.json({ success: false, message: "포인트 부족!" });
    }
});

// ★ [핵심] 답변하고 보상 받기
app.post('/answer-mission', (req, res) => {
    const { username, pinId, answerText, photo } = req.body;
    const user = users.find(u => u.username === username);
    
    // 핀 찾기
    const pin = pins.find(p => p.id === pinId);
    
    if (pin && user) {
        // ★ 질문자가 걸어둔 현상금(reward) 만큼 획득
        const reward = pin.reward || 100; // 기본 100
        user.points += reward;

        pin.type = 'answered';
        pin.answerText = answerText;
        pin.answerPhoto = photo;
        pin.answerBy = username;
        pin.createdAt = Date.now(); // 10분 연장
        
        io.emit('pinAnswered', { pinId: pin.id, updatedPin: pin, asker: pin.username });
        
        res.json({ success: true, newPoints: user.points, message: `답변 등록 완료! +${reward} BP` });
    } else {
        res.json({ success: false, message: "핀을 찾을 수 없습니다." });
    }
});

// 소켓 통신
io.on('connection', (socket) => {
    console.log('✅ User connected');

    // 핀 로딩 (답변된건 10분, 일반은 30분)
    const now = Date.now();
    const activePins = pins.filter(p => {
        const duration = p.type === 'answered' ? 10 * 60000 : 30 * 60000;
        return (now - p.createdAt) < duration;
    });
    socket.emit('loadPins', activePins);

    // ★ [핵심] 질문 핀 생성 (포인트 차감 로직)
    socket.on('bossSignal', (data) => {
        const user = users.find(u => u.username === data.username);
        
        // 질문 타입에 따른 비용 계산
        let cost = 0;
        if (data.rewardType === 'text') cost = 100;
        if (data.rewardType === 'photo') cost = 500;

        if (user) {
            if (user.points >= cost) {
                user.points -= cost; // 포인트 차감
                
                const newPin = { 
                    ...data, 
                    id: Date.now().toString(), 
                    _id: Date.now().toString(), 
                    createdAt: Date.now(),
                    reward: cost // ★ 핀에 현상금 금액 기록
                };
                pins.push(newPin);
                
                io.emit('newSignal', newPin); // 지도에 핀 생성
                
                // 나한테만 포인트 업데이트 알림 (잔액 갱신용)
                socket.emit('pointUpdated', user.points);
            } else {
                // 포인트 부족 시 에러 전송
                socket.emit('errorMsg', "포인트가 부족합니다!");
            }
        }
    });

    socket.on('deletePin', (pinId) => {
        pins = pins.filter(p => p.id !== pinId && p._id !== pinId);
        io.emit('removePin', pinId);
    });
    
    socket.on('reportPin', (pinId) => {
        pins = pins.filter(p => p.id !== pinId && p._id !== pinId);
        io.emit('removePin', pinId);
    });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => { console.log(`🚀 BluePin V13.5 Server running on port ${PORT}`); });
