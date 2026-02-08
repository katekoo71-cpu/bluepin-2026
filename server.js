// server.js (V13.6 - 마이페이지 & 히스토리)
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

// 임시 데이터 저장소
let pins = [];
let users = []; 
// User 구조: { username, password, role, storeName, points, tier, history: [] }

// ★ 히스토리 기록 함수
function logHistory(user, type, amount, desc) {
    if (!user.history) user.history = [];
    user.history.unshift({
        type, // 'earn', 'spend', 'system'
        amount,
        desc,
        date: new Date().toLocaleString()
    });
}

app.get('/', (req, res) => { res.sendFile(path.join(__dirname, 'index.html')); });

// 회원가입
app.post('/register', (req, res) => {
    const { username, password, role, storeName } = req.body;
    const existing = users.find(u => u.username === username);
    if (existing) return res.json({ success: false, message: "이미 있는 ID입니다." });

    const newUser = {
        username, password, role, 
        storeName: role === 'host' ? storeName : null,
        points: role === 'guest' ? 1000 : 0,
        tier: role === 'host' ? 'Free' : null, // 점주 등급 (Free, Basic, Pro)
        history: []
    };

    if (role === 'guest') logHistory(newUser, 'earn', 1000, '회원가입 축하금');
    
    users.push(newUser);
    res.json({ success: true, message: "가입 성공!" });
});

// 로그인
app.post('/login', (req, res) => {
    const { username, password } = req.body;
    const user = users.find(u => u.username === username && u.password === password);
    if (user) {
        res.json({ 
            success: true, 
            role: user.role, 
            storeName: user.storeName, 
            points: user.points,
            tier: user.tier // 등급 정보도 전송
        });
    } else {
        res.json({ success: false, message: "ID 또는 비번 틀림" });
    }
});

// ★ [NEW] 마이페이지 정보 조회
app.post('/my-info', (req, res) => {
    const { username } = req.body;
    const user = users.find(u => u.username === username);
    if (user) {
        res.json({ 
            success: true, 
            user: {
                username: user.username,
                role: user.role,
                storeName: user.storeName,
                points: user.points,
                tier: user.tier,
                history: user.history // 활동 내역 전송
            }
        });
    } else {
        res.json({ success: false });
    }
});

// ★ [NEW] 점주 등급 업그레이드 (결제 시뮬레이션)
app.post('/upgrade-tier', (req, res) => {
    const { username, tier } = req.body; // 'Basic' or 'Pro'
    const user = users.find(u => u.username === username);
    if (user) {
        user.tier = tier;
        res.json({ success: true, newTier: tier });
    } else {
        res.json({ success: false });
    }
});

// Sound Pay
app.post('/use-point', (req, res) => {
    const { username } = req.body;
    const user = users.find(u => u.username === username);
    if (user && user.points >= 1000) {
        user.points -= 1000;
        logHistory(user, 'spend', -1000, 'Sound Pay 결제'); // 기록
        res.json({ success: true, newPoints: user.points });
    } else {
        res.json({ success: false, message: "포인트 부족!" });
    }
});

// 답변 보상
app.post('/answer-mission', (req, res) => {
    const { username, pinId, answerText, photo } = req.body;
    const user = users.find(u => u.username === username);
    const pin = pins.find(p => p.id === pinId);
    
    if (pin && user) {
        const reward = pin.reward || 100;
        user.points += reward;
        logHistory(user, 'earn', reward, `미션 성공 (${photo ? '사진' : '텍스트'})`); // 기록

        pin.type = 'answered';
        pin.answerText = answerText;
        pin.answerPhoto = photo;
        pin.answerBy = username;
        pin.createdAt = Date.now();
        
        io.emit('pinAnswered', { pinId: pin.id, updatedPin: pin, asker: pin.username });
        res.json({ success: true, newPoints: user.points });
    } else {
        res.json({ success: false, message: "오류 발생" });
    }
});

// 소켓 통신
io.on('connection', (socket) => {
    console.log('✅ User connected');
    const now = Date.now();
    const activePins = pins.filter(p => {
        const duration = p.type === 'answered' ? 10 * 60000 : 30 * 60000;
        return (now - p.createdAt) < duration;
    });
    socket.emit('loadPins', activePins);

    socket.on('bossSignal', (data) => {
        const user = users.find(u => u.username === data.username);
        let cost = (data.rewardType === 'photo') ? 500 : 100;

        if (user) {
            if (user.points >= cost) {
                user.points -= cost;
                logHistory(user, 'spend', -cost, `질문 등록 (${data.rewardType})`); // 기록
                
                const newPin = { 
                    ...data, 
                    id: Date.now().toString(), 
                    _id: Date.now().toString(), 
                    createdAt: Date.now(),
                    reward: cost 
                };
                pins.push(newPin);
                
                io.emit('newSignal', newPin);
                socket.emit('pointUpdated', user.points);
            } else {
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
server.listen(PORT, () => { console.log(`🚀 BluePin V13.6 Server running on port ${PORT}`); });
