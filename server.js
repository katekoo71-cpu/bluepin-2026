const express = require('express');
const app = express();
const http = require('http');
const server = http.createServer(app);
const { Server } = require("socket.io");
const io = new Server(server);
const mongoose = require('mongoose');

// ★ 창업가님의 DB 주소 (그대로 유지)
const MONGO_URI = "mongodb+srv://bluepinadmin:bluepinadmin1234@cluster0.3pq60lz.mongodb.net/?retryWrites=true&w=majority&appName=Cluster0";

mongoose.connect(MONGO_URI)
  .then(() => console.log('✅ MongoDB 연결 성공!'))
  .catch(err => console.log('🔥 DB 연결 실패:', err));

// 1. 핀(Pin) 스키마
const pinSchema = new mongoose.Schema({
  lat: Number,
  lng: Number,
  type: String,
  message: String,
  storeName: String,
  createdAt: { type: Date, default: Date.now, expires: 1800 }
});
const Pin = mongoose.model('Pin', pinSchema);

// 2. 유저(User) 스키마 (업그레이드: 역할, 포인트 추가)
const userSchema = new mongoose.Schema({
  username: { type: String, required: true, unique: true },
  password: { type: String, required: true },
  storeName: String, // 사장님일 때만 사용
  role: { type: String, default: 'guest' }, // 'host' (사장) 또는 'guest' (손님)
  points: { type: Number, default: 0 }      // 포인트 잔액
});
const User = mongoose.model('User', userSchema);

app.use(express.json());
app.use(express.static(__dirname));

app.get('/', (req, res) => { res.sendFile(__dirname + '/index.html'); });

// 3. 회원가입 API (손님이면 1000포인트 증정!)
app.post('/register', async (req, res) => {
  try {
    const { username, password, storeName, role } = req.body;
    
    // 이미 있는지 확인
    const existingUser = await User.findOne({ username });
    if (existingUser) return res.status(400).json({ success: false, message: "이미 있는 아이디입니다." });

    // 새 유저 만들기
    const newUser = new User({
      username,
      password,
      storeName: role === 'host' ? storeName : null, // 손님은 가게이름 없음
      role: role || 'guest',
      points: role === 'guest' ? 1000 : 0 // ★ 손님 가입 선물: 1000 BP!
    });
    
    await newUser.save();
    res.json({ success: true, message: "가입 성공! (손님은 1000P 지급됨)" });
  } catch (err) {
    res.status(500).json({ success: false, message: "서버 오류" });
  }
});

// 4. 로그인 API (내 포인트 정보도 같이 보냄)
app.post('/login', async (req, res) => {
  try {
    const { username, password } = req.body;
    const user = await User.findOne({ username, password });
    
    if (user) {
      res.json({ 
        success: true, 
        role: user.role, 
        storeName: user.storeName,
        points: user.points // ★ 로그인하면 잔액 알려줌
      });
    } else {
      res.status(400).json({ success: false, message: "아이디 또는 비번이 틀렸습니다." });
    }
  } catch (err) {
    res.status(500).json({ success: false, message: "서버 오류" });
  }
});

// 5. 소켓 통신
io.on('connection', async (socket) => {
  const activePins = await Pin.find();
  socket.emit('loadPins', activePins);

  socket.on('bossSignal', async (data) => {
    const newPin = new Pin({
      lat: data.lat, lng: data.lng, type: data.type, message: data.message, storeName: data.storeName
    });
    await newPin.save();
    io.emit('newSignal', data);
  });
});

const port = process.env.PORT || 3000;
server.listen(port, () => { console.log(`🚀 BluePin V8.0 Server Started: ${port}`); });
