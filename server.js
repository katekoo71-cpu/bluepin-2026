// server.js
const express = require('express');
const http = require('http');
const socketIo = require('socket.io');
const mongoose = require('mongoose');
const path = require('path');
const cors = require('cors');

const app = express();
const server = http.createServer(app);
const io = socketIo(server);

// 1. 미들웨어 설정
app.use(cors());
app.use(express.json({ limit: '10mb' })); // 사진 업로드 용량 제한 늘림
app.use(express.static(path.join(__dirname, 'public')));

// 2. MongoDB 연결 (Render 환경 변수 사용, 없으면 로컬)
const MONGO_URI = process.env.MONGO_URI || 'mongodb://localhost:27017/bluepin';
mongoose.connect(MONGO_URI)
    .then(() => console.log('✅ MongoDB Connected!'))
    .catch(err => console.error('❌ MongoDB Error:', err));

// 3. 데이터 스키마 정의
// (1) 핀(Pin) 스키마
const pinSchema = new mongoose.Schema({
    lat: Number,
    lng: Number,
    type: String, // 'question', 'discount', 'fresh', 'seat', 'answered'
    message: String,
    storeName: String,
    username: String, // 핀 작성자 ID
    createdAt: { type: Date, default: Date.now }, // 생성 시간
    
    // ★ 답변 관련 필드 추가
    answerText: String,
    answerPhoto: String, // Base64 이미지 데이터
    answerBy: String     // 답변자 ID
});
const Pin = mongoose.model('Pin', pinSchema);

// (2) 유저(User) 스키마
const userSchema = new mongoose.Schema({
    username: { type: String, required: true, unique: true },
    password: { type: String, required: true },
    role: String, // 'host' or 'guest'
    storeName: String,
    points: { type: Number, default: 0 } // BP 포인트
});
const User = mongoose.model('User', userSchema);

// 4. API 라우트 (회원가입, 로그인, 포인트 등)

// 회원가입
app.post('/register', async (req, res) => {
    try {
        const { username, password, role, storeName } = req.body;
        const existingUser = await User.findOne({ username });
        if (existingUser) return res.json({ success: false, message: "이미 존재하는 ID입니다." });

        const newUser = new User({ 
            username, 
            password, 
            role, 
            storeName: role === 'host' ? storeName : null,
            points: role === 'guest' ? 1000 : 0 // 가입 축하금
        });
        await newUser.save();
        res.json({ success: true, message: "가입 성공!" });
    } catch (e) {
        res.json({ success: false, message: "오류 발생" });
    }
});

// 로그인
app.post('/login', async (req, res) => {
    try {
        const { username, password } = req.body;
        const user = await User.findOne({ username, password });
        if (user) {
            res.json({ 
                success: true, 
                role: user.role, 
                storeName: user.storeName || "", 
                points: user.points 
            });
        } else {
            res.json({ success: false, message: "ID 또는 비번이 틀렸습니다." });
        }
    } catch (e) {
        res.json({ success: false, message: "서버 오류" });
    }
});

// 포인트 사용 (Sound Pay)
app.post('/use-point', async (req, res) => {
    try {
        const { username } = req.body;
        const user = await User.findOne({ username });
        if (!user) return res.json({ success: false, message: "유저 없음" });
        
        if (user.points >= 1000) {
            user.points -= 1000;
            await user.save();
            res.json({ success: true, newPoints: user.points });
        } else {
            res.json({ success: false, message: "포인트 부족!" });
        }
    } catch (e) {
        res.json({ success: false, message: "오류" });
    }
});

// ★ [핵심 기능] 미션 답변하기 (텍스트 or 사진)
app.post('/answer-mission', async (req, res) => {
    try {
        const { username, pinId, answerText, photo } = req.body;
        
        // 1. 답변자 포인트 지급
        const user = await User.findOne({ username });
        let reward = 0;
        if (photo) reward = 500; // 사진 인증
        else if (answerText) reward = 100; // 텍스트 제보
        
        if (user) {
            user.points += reward;
            await user.save();
        }

        // 2. 핀 상태 업데이트 (★ 삭제가 아니라 수정!)
        const pin = await Pin.findById(pinId);
        if (pin) {
            pin.type = 'answered'; // 타입을 '답변완료'로 변경
            if (answerText) pin.answerText = answerText;
            if (photo) pin.answerPhoto = photo;
            pin.answerBy = username; // 답변자 기록 (익명 표시용)
            
            // ★ 중요: 생성 시간을 '지금'으로 초기화 (그래야 클라이언트에서 10분 카운트다운 다시 시작)
            pin.createdAt = new Date(); 
            
            await pin.save();

            // 3. 모든 사람에게 "답변 달렸어요!" 알림 전송 (초록 핀으로 교체하라고 지시)
            io.emit('pinAnswered', { 
                pinId: pin._id, 
                updatedPin: pin,
                asker: pin.username // 원래 질문자에게 알림 주기 위해
            });
        }

        res.json({ success: true, newPoints: user ? user.points : 0 });

    } catch (e) {
        console.error(e);
        res.json({ success: false, message: "처리 중 오류 발생" });
    }
});


// 5. 소켓 통신 (실시간 핀 관리)
io.on('connection', async (socket) => {
    console.log('✅ User connected');

    // 접속 시 현재 살아있는 핀들 다 보내주기
    // (답변 완료된 핀은 10분, 일반 핀은 30분 이내인 것만 조회해야 함 - 간단히 30분 전체 조회 후 클라이언트 필터링)
    const thirtyMinutesAgo = new Date(Date.now() - 30 * 60 * 1000);
    const pins = await Pin.find({ createdAt: { $gte: thirtyMinutesAgo } });
    socket.emit('loadPins', pins);

    // 새 핀 생성 (질문, 홍보 등)
    socket.on('bossSignal', async (data) => {
        try {
            const newPin = new Pin(data);
            await newPin.save();
            io.emit('newSignal', newPin); // 모두에게 전파
        } catch (e) {
            console.error("Pin save error:", e);
        }
    });

    // 핀 삭제 (작성자 본인 삭제)
    socket.on('deletePin', async (pinId) => {
        try {
            await Pin.findByIdAndDelete(pinId);
            io.emit('removePin', pinId); // 지도에서 지우라고 전파
        } catch (e) {
            console.error(e);
        }
    });

    // 신고 기능 (누적 없이 즉시 삭제 - MVP용)
    socket.on('reportPin', async (pinId) => {
        try {
            await Pin.findByIdAndDelete(pinId); // DB 삭제
            io.emit('removePin', pinId); // 모두의 지도에서 삭제
        } catch (e) {
            console.error(e);
        }
    });

    socket.on('disconnect', () => {
        console.log('❌ User disconnected');
    });
});

// 6. 서버 시작
const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
    console.log(`🚀 BluePin Server V13.2 running on port ${PORT}`);
});
