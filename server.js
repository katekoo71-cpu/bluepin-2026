// server.js (V13.8 - 점주 무료 핀 & UI 수정 대응)
require('dotenv').config();
const express = require('express');
const http = require('http');
const socketIo = require('socket.io');
const path = require('path');
const cors = require('cors');
const fs = require('fs');
const TossPayments = require('@tosspayments/server-sdk');

// 토스 클라이언트 초기화
const tossClient = TossPayments(process.env.TOSS_SECRET_KEY);

const app = express();
const server = http.createServer(app);
const io = socketIo(server);

app.use(cors());
app.use(express.json({ limit: '10mb' }));
app.use(express.static(__dirname));

const DB_PATH = path.join(__dirname, 'db.json');
function loadDB() {
    try {
        const raw = fs.readFileSync(DB_PATH, 'utf8');
        return JSON.parse(raw);
    } catch (e) {
        return { users: [], questions: [], answers: [], escrow: [], transactions: [], withdrawals: [], pins: [], stores: [], trust_reports: [] };
    }
}
function saveDB() {
    fs.writeFileSync(DB_PATH, JSON.stringify(db, null, 2));
}

let db = loadDB();
// 기존 로직 호환
let pins = db.pins;
let users = db.users;

const MIN_TEXT_LEN = 5;
const MAX_TEXT_LEN = 15;
const REPORT_BAN_THRESHOLD = 3;
const ADMIN_KEY = process.env.ADMIN_KEY || "bluepin-admin";
const BAD_WORDS = [
    "시발","씨발","ㅅㅂ","병신","좆","미친","개새","fuck","shit","sex","porn",
    "도박","토토","바카라","카지노","대출","성인","성인광고"
];

// 히스토리 기록
function logHistory(user, type, amount, desc) {
    if (!user.history) user.history = [];
    user.history.unshift({
        type, 
        amount,
        desc,
        date: new Date().toLocaleString()
    });
}

function normalizeText(text) {
    return (text || '').trim();
}

function isValidText(text) {
    const t = normalizeText(text);
    return t.length >= MIN_TEXT_LEN && t.length <= MAX_TEXT_LEN;
}

function hasBadWord(text) {
    const t = normalizeText(text).toLowerCase();
    return BAD_WORDS.some(w => t.includes(w));
}

app.get('/', (req, res) => { res.sendFile(path.join(__dirname, 'index.html')); });

// 질문 생성 API
app.post('/api/questions/create', async (req, res) => {
    try {
        const { userId, text, lat, lng, amount, type } = req.body;
        const questionId = `Q_${Date.now()}`;
        const question = {
            id: questionId,
            asker_id: userId,
            text: text,
            lat: parseFloat(lat),
            lng: parseFloat(lng),
            amount: parseInt(amount),
            type: type,
            status: 'payment_pending',
            created_at: new Date().toISOString(),
            payment_key: null
        };

        db.questions.push(question);
        saveDB();

        const payment = await tossClient.createPayment({
            amount: parseInt(amount),
            orderId: questionId,
            orderName: text.substring(0, 20),
            customerName: userId,
            successUrl: `${process.env.BASE_URL}/payment/success?questionId=${questionId}`,
            failUrl: `${process.env.BASE_URL}/payment/fail`
        });

        res.json({
            success: true,
            checkoutUrl: payment.checkoutUrl,
            questionId: questionId
        });
    } catch (error) {
        console.error('질문 생성 오류:', error);
        res.status(500).json({ success: false, error: error.message });
    }
});

// 결제 성공 콜백
app.get('/payment/success', async (req, res) => {
    try {
        const { questionId, paymentKey, amount } = req.query;

        const approval = await tossClient.confirmPayment({
            paymentKey: paymentKey,
            orderId: questionId,
            amount: parseInt(amount)
        });

        if (approval.status === 'DONE') {
            const question = db.questions.find(q => q.id === questionId);
            if (!question) return res.redirect('/payment/fail');
            question.status = 'open';
            question.payment_key = paymentKey;

            db.escrow.push({
                id: `ESC_${Date.now()}`,
                question_id: questionId,
                amount: parseInt(amount),
                asker_id: question.asker_id,
                answerer_id: null,
                status: 'held',
                created_at: new Date().toISOString(),
                release_at: new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString()
            });

            saveDB();

            io.emit('new_question', {
                question: question,
                message: `근처에서 질문! +${amount}원`
            });

            return res.send('<h1>✅ 질문 등록 완료!</h1><p><a href="/">돌아가기</a></p>');
        }

        res.redirect('/payment/fail');
    } catch (error) {
        console.error('결제 승인 오류:', error);
        res.redirect('/payment/fail');
    }
});

app.get('/payment/fail', (req, res) => {
    res.send('<h1>❌ 결제 실패</h1><p><a href="/">다시 시도</a></p>');
});

// 회원가입
app.post('/register', (req, res) => {
    const { username, password, role, storeName } = req.body;
    const existing = users.find(u => u.username === username);
    if (existing) return res.json({ success: false, message: "이미 있는 ID입니다." });

    const newUser = {
        username, password, role, 
        storeName: role === 'host' ? storeName : null,
        points: role === 'guest' ? 1000 : 0,
        tier: role === 'host' ? 'Free' : null,
        history: [],
        reputation: 0,
        banned: false,
        reportCount: 0,
        shadowbanned: false
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
        res.json({ success: true, role: user.role, storeName: user.storeName, points: user.points, tier: user.tier, reputation: user.reputation, banned: user.banned, shadowbanned: user.shadowbanned, reportCount: user.reportCount });
    } else {
        res.json({ success: false, message: "ID 또는 비번 틀림" });
    }
});

// 마이페이지 정보
app.post('/my-info', (req, res) => {
    const { username } = req.body;
    const user = users.find(u => u.username === username);
    if (user) {
        res.json({ success: true, user: { username: user.username, role: user.role, storeName: user.storeName, points: user.points, tier: user.tier, history: user.history, reputation: user.reputation, banned: user.banned, shadowbanned: user.shadowbanned, reportCount: user.reportCount } });
    } else {
        res.json({ success: false });
    }
});

// 등급 업그레이드
app.post('/upgrade-tier', (req, res) => {
    const { username, tier } = req.body;
    const user = users.find(u => u.username === username);
    if (user) { user.tier = tier; res.json({ success: true, newTier: tier }); } 
    else { res.json({ success: false }); }
});

// Sound Pay
app.post('/use-point', (req, res) => {
    const { username, amount, pinId } = req.body;
    const user = users.find(u => u.username === username);
    const useAmount = parseInt(amount, 10);
    if (!user) return res.json({ success: false, message: "사용자 없음" });
    if (!Number.isFinite(useAmount) || useAmount <= 0) return res.json({ success: false, message: "포인트 금액 오류" });

    if (pinId) {
        const pin = pins.find(p => p.id === pinId || p._id === pinId);
        if (!pin || !pin.redeemPoints) return res.json({ success: false, message: "포인트 사용 핀 없음" });
        if (parseInt(pin.redeemPoints, 10) !== useAmount) return res.json({ success: false, message: "포인트 금액 불일치" });
    }

    if (user.points >= useAmount) {
        user.points -= useAmount;
        logHistory(user, 'spend', -useAmount, pinId ? `핀 포인트 사용 (${useAmount} BP)` : 'Sound Pay 결제');
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
        if (user.banned) return res.json({ success: false, message: "작성 권한이 제한되었습니다." });
        if (answerText && hasBadWord(answerText)) return res.json({ success: false, message: "작성할 수 없는 단어가 포함되어 있습니다." });
        if (pin.rewardType === 'photo' && !photo) {
            return res.json({ success: false, message: "사진 답변만 가능합니다." });
        }
        if (pin.rewardType === 'text' && !answerText) {
            return res.json({ success: false, message: "텍스트 답변만 가능합니다." });
        }
        if (answerText && !isValidText(answerText)) {
            return res.json({ success: false, message: "답변은 5~15자로 입력해주세요." });
        }
        const reward = pin.reward || 100;
        user.points += reward;
        logHistory(user, 'earn', reward, `미션 성공 (${photo ? '사진' : '텍스트'})`);

        pin.type = 'answered';
        pin.answerText = answerText;
        pin.answerPhoto = photo;
        pin.answerBy = username;
        pin.createdAt = Date.now(); // 10분 연장
        pin.satisfied = false;
        
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
    const publicPins = activePins.filter(p => !p.hidden);
    socket.emit('loadPins', publicPins);

    socket.on('identify', (username) => {
        socket.username = username;
        const userPins = activePins.filter(p => !p.hidden || p.username === username);
        socket.emit('loadPins', userPins);
    });

    // ★ [핵심 수정] 핀 생성 로직 (점주는 무료, 손님은 유료)
    socket.on('bossSignal', (data) => {
        const user = users.find(u => u.username === data.username);
        if (!user) return;
        if (user.banned) {
            socket.emit('errorMsg', "신고로 인해 작성 권한이 제한되었습니다. 운영자에게 문의해주세요.");
            return;
        }

        let cost = 0;
        const messageText = normalizeText(data.message);
        if (!isValidText(messageText)) {
            socket.emit('errorMsg', "문구는 5~15자로 입력해주세요.");
            return;
        }
        if (hasBadWord(messageText)) {
            socket.emit('errorMsg', "작성할 수 없는 단어가 포함되어 있습니다.");
            return;
        }

        // 1. 손님이 질문할 때만 돈을 받음
        if (user.role === 'guest' && data.type === 'question') {
            const rewardType = (data.rewardType === 'photo') ? 'photo' : 'text';
            cost = (rewardType === 'photo') ? 500 : 100;
            
            if (user.points < cost) {
                socket.emit('errorMsg', "포인트가 부족합니다! (질문 작성 비용)");
                return; // 여기서 중단
            }

            // 포인트 차감
            user.points -= cost;
            logHistory(user, 'spend', -cost, `질문 등록 (${rewardType === 'photo' ? '사진' : '텍스트'})`);
            socket.emit('pointUpdated', user.points);
        }

        // 2. 점주는 cost = 0 이므로 포인트 검사 없이 통과!
        
        // 핀 생성
        const redeemPoints = (user.role === 'host' && data.redeemPoints) ? parseInt(data.redeemPoints, 10) : null;
        if (redeemPoints && (!Number.isFinite(redeemPoints) || redeemPoints <= 0)) {
            socket.emit('errorMsg', "포인트 제공 금액을 확인해주세요.");
            return;
        }
        const newPin = { 
            ...data,
            message: messageText,
            id: Date.now().toString(), 
            _id: Date.now().toString(), 
            createdAt: Date.now(),
            reward: cost, // 손님이 낸 돈이 현상금이 됨 (점주는 0원)
            rewardType: (data.type === 'question') ? ((data.rewardType === 'photo') ? 'photo' : 'text') : null,
            pinOwnerRole: data.pinOwnerRole || user.role,
            redeemPoints: redeemPoints,
            pinOwnerTier: user.tier || null,
            hidden: user.shadowbanned === true,
            satisfied: false
        };
        pins.push(newPin);
        
        if (user.shadowbanned) {
            socket.emit('newSignal', newPin);
        } else {
            io.emit('newSignal', newPin);
        }
    });

    socket.on('deletePin', (pinId) => {
        pins = pins.filter(p => p.id !== pinId && p._id !== pinId);
        io.emit('removePin', pinId);
    });
    
    socket.on('reportPin', (pinId) => {
        const target = pins.find(p => p.id === pinId || p._id === pinId);
        pins = pins.filter(p => p.id !== pinId && p._id !== pinId);
        io.emit('removePin', pinId);
        if (target && target.username) {
            const targetUser = users.find(u => u.username === target.username);
            if (targetUser) {
                targetUser.reportCount = (targetUser.reportCount || 0) + 1;
                targetUser.shadowbanned = true;
                if (targetUser.reportCount >= REPORT_BAN_THRESHOLD) {
                    targetUser.banned = true;
                    targetUser.shadowbanned = true;
                }
            }
        }
    });
});

app.post('/satisfy', (req, res) => {
    const { username, pinId } = req.body;
    const pin = pins.find(p => p.id === pinId || p._id === pinId);
    if (!pin) return res.json({ success: false, message: "핀 없음" });
    if (pin.username !== username) return res.json({ success: false, message: "권한 없음" });
    if (pin.type !== 'answered' || !pin.answerBy) return res.json({ success: false, message: "답변 없음" });
    if (pin.satisfied) return res.json({ success: false, message: "이미 처리됨" });
    const answerUser = users.find(u => u.username === pin.answerBy);
    if (!answerUser) return res.json({ success: false, message: "답변자 없음" });
    answerUser.reputation = (answerUser.reputation || 0) + 1;
    pin.satisfied = true;
    res.json({ success: true, reputation: answerUser.reputation });
});

app.get('/admin', (req, res) => {
    res.sendFile(path.join(__dirname, 'admin.html'));
});

app.post('/admin-data', (req, res) => {
    const { key } = req.body;
    if (key !== ADMIN_KEY) return res.json({ success: false, message: "권한 없음" });
    const allUsers = users.map(u => ({
        username: u.username,
        role: u.role,
        reportCount: u.reportCount || 0,
        banned: u.banned,
        shadowbanned: u.shadowbanned,
        reputation: u.reputation || 0
    }));
    const activePins = pins.map(p => ({ id: p.id, storeName: p.storeName, username: p.username, message: p.message, hidden: p.hidden }));
    res.json({ success: true, users: allUsers, activePins, threshold: REPORT_BAN_THRESHOLD });
});

app.post('/admin-unban', (req, res) => {
    const { key, username } = req.body;
    if (key !== ADMIN_KEY) return res.json({ success: false, message: "권한 없음" });
    const user = users.find(u => u.username === username);
    if (!user) return res.json({ success: false, message: "사용자 없음" });
    user.banned = false;
    user.shadowbanned = false;
    user.reportCount = 0;
    pins.forEach(p => { if (p.username === username) p.hidden = false; });
    res.json({ success: true });
});

app.post('/admin-user-update', (req, res) => {
    const { key, username, banned, shadowbanned, reportCount } = req.body;
    if (key !== ADMIN_KEY) return res.json({ success: false, message: "권한 없음" });
    const user = users.find(u => u.username === username);
    if (!user) return res.json({ success: false, message: "사용자 없음" });
    if (typeof banned === 'boolean') user.banned = banned;
    if (typeof shadowbanned === 'boolean') user.shadowbanned = shadowbanned;
    if (Number.isFinite(parseInt(reportCount, 10))) user.reportCount = parseInt(reportCount, 10);
    pins.forEach(p => {
        if (p.username === username) {
            p.hidden = user.shadowbanned === true;
        }
    });
    res.json({ success: true });
});

app.post('/admin-pin-hide', (req, res) => {
    const { key, pinId, hidden } = req.body;
    if (key !== ADMIN_KEY) return res.json({ success: false, message: "권한 없음" });
    const pin = pins.find(p => p.id === pinId || p._id === pinId);
    if (!pin) return res.json({ success: false, message: "핀 없음" });
    pin.hidden = !!hidden;
    res.json({ success: true });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => { console.log(`🚀 BluePin V13.8 Server running on port ${PORT}`); });
