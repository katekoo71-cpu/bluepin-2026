// server.js (테스트 모드: DB 없이 즉시 실행)
const express = require('express');
const http = require('http');
const socketIo = require('socket.io');
const path = require('path');
const cors = require('cors');

const app = express();
const server = http.createServer(app);
const io = socketIo(server);

// 1. 미들웨어 설정
app.use(cors());
app.use(express.json({ limit: '10mb' }));
app.use(express.static(__dirname)); // 현재 폴더에서 화면 파일 찾기

// ★ [핵심] DB 대신 임시로 저장할 변수들 (서버 꺼지면 초기화됨)
let pins = [];
let users = [];

// 2. API 라우트
app.get('/', (req, res) => {
    res.sendFile(path.join(__dirname, 'index.html'));
});

// 회원가입 (메모리에 저장)
app.post('/register', (req, res) => {
    const { username, password, role, storeName } = req.body;
    // 중복 체크
    const existing = users.find(u => u.username === username);
    if (existing) return res.json({ success: false, message: "이미 있는 ID입니다." });

    const newUser = {
        username, 
        password, 
        role, 
        storeName: role === 'host' ? storeName : null,
        points: role === 'guest' ? 1000 : 0
    };
    users.push(newUser); // 배열에 추가
    console.log("✅ 가입 완료:", newUser);
    res.json({ success: true, message: "가입 성공 (테스트 모드)" });
});

// 로그인
app.post('/login', (req, res) => {
    const { username, password } = req.body;
    const user = users.find(u => u.username === username && u.password === password);
    
    if (user) {
        res.json({ success: true, role: user.role, storeName: user.storeName, points: user.points });
    } else {
        res.json({ success: false, message: "ID 또는 비번 틀림 (테스트 계정인지 확인하세요)" });
    }
});

// 포인트 사용
app.post('/use-point', (req, res) => {
    const { username } = req.body;
    const user = users.find(u => u.username === username);
    if (user && user.points >= 1000) {
        user.points -= 1000;
        res.json({ success: true, newPoints: user.points });
    } else {
        res.json({ success: false, message: "포인트 부족" });
    }
});

// 미션 답변
app.post('/answer-mission', (req, res) => {
    const { username, pinId, answerText, photo } = req.body;
    const user = users.find(u => u.username === username);
    
    // 포인트 지급
    let reward = photo ? 500 : 100;
    if (user) user.points += reward;

    // 핀 찾아서 업데이트
    const pin = pins.find(p => p.id === pinId);
    if (pin) {
        pin.type = 'answered';
        pin.answerText = answerText;
        pin.answerPhoto = photo;
        pin.answerBy = username;
        pin.createdAt = Date.now(); // 시간 초기화 (10분 연장)
        
        // 모두에게 알림
        io.emit('pinAnswered', { pinId: pin.id, updatedPin: pin, asker: pin.username });
    }
    
    res.json({ success: true, newPoints: user ? user.points : 0 });
});

// 3. 소켓 통신 (실시간 핀 관리)
io.on('connection', (socket) => {
    console.log('✅ User connected');

    // 접속 시 최근 30분 내 핀만 보내주기
    const now = Date.now();
    const activePins = pins.filter(p => {
        // 답변 핀은 10분, 일반 핀은 30분
        const duration = p.type === 'answered' ? 10 * 60000 : 30 * 60000;
        return (now - p.createdAt) < duration;
    });
    socket.emit('loadPins', activePins);

    // 새 핀 생성
    socket.on('bossSignal', (data) => {
        // ID와 시간을 서버에서 부여
        const newPin = { 
            ...data, 
            id: Date.now().toString(), // 임시 ID 생성
            _id: Date.now().toString(), // 클라이언트 호환용
            createdAt: Date.now() 
        };
        pins.push(newPin);
        io.emit('newSignal', newPin);
    });

    // 핀 삭제
    socket.on('deletePin', (pinId) => {
        pins = pins.filter(p => p.id !== pinId && p._id !== pinId);
        io.emit('removePin', pinId);
    });
    
    // 신고
    socket.on('reportPin', (pinId) => {
        pins = pins.filter(p => p.id !== pinId && p._id !== pinId);
        io.emit('removePin', pinId);
    });
});

// 서버 시작
const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
    console.log(`🚀 BluePin TEST Server running on port ${PORT}`);
});
