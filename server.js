const express = require('express');
const app = express();
const http = require('http');
const server = http.createServer(app);
const { Server } = require("socket.io");
const io = new Server(server);
const mongoose = require('mongoose');

// DB 주소
const MONGO_URI = "mongodb+srv://bluepinadmin:bluepinadmin1234@cluster0.3pq60lz.mongodb.net/?retryWrites=true&w=majority&appName=Cluster0";

mongoose.connect(MONGO_URI)
  .then(() => console.log('✅ MongoDB 연결 성공!'))
  .catch(err => console.log('🔥 DB 연결 실패:', err));

const pinSchema = new mongoose.Schema({
  lat: Number, lng: Number, type: String, message: String, storeName: String, username: String,
  createdAt: { type: Date, default: Date.now, expires: 1800 }
});
const Pin = mongoose.model('Pin', pinSchema);

const userSchema = new mongoose.Schema({
  username: { type: String, required: true, unique: true },
  password: { type: String, required: true },
  storeName: String,
  role: { type: String, default: 'guest' },
  points: { type: Number, default: 0 }
});
const User = mongoose.model('User', userSchema);

// 사진 용량 제한 50MB
app.use(express.json({ limit: '50mb' }));
app.use(express.static(__dirname));

app.get('/', (req, res) => { res.sendFile(__dirname + '/index.html'); });

app.post('/register', async (req, res) => {
  try {
    const { username, password, storeName, role } = req.body;
    const existingUser = await User.findOne({ username });
    if (existingUser) return res.status(400).json({ success: false, message: "이미 있는 아이디입니다." });
    const newUser = new User({
      username, password,
      storeName: role === 'host' ? storeName : null,
      role: role || 'guest',
      points: role === 'guest' ? 1000 : 0
    });
    await newUser.save();
    res.json({ success: true, message: "가입 성공!" });
  } catch (err) { res.status(500).json({ success: false, message: "서버 오류" }); }
});

app.post('/login', async (req, res) => {
  try {
    const { username, password } = req.body;
    const user = await User.findOne({ username, password });
    if (user) {
      res.json({ success: true, role: user.role, storeName: user.storeName, points: user.points });
    } else { res.status(400).json({ success: false, message: "로그인 실패" }); }
  } catch (err) { res.status(500).json({ success: false, message: "서버 오류" }); }
});

app.post('/use-point', async (req, res) => {
  try {
    const { username } = req.body;
    const user = await User.findOne({ username });
    if (user && user.points >= 1000) {
      user.points -= 1000;
      await user.save();
      res.json({ success: true, newPoints: user.points, message: "사용 완료!" });
    } else { res.json({ success: false, message: "잔액 부족!" }); }
  } catch (err) { res.status(500).json({ success: false, message: "오류" }); }
});

// ★ [UPDATE] 답변 처리 (텍스트 OR 사진)
app.post('/answer-mission', async (req, res) => {
  try {
    const { username, pinId, photo, answerText } = req.body; 
    
    const user = await User.findOne({ username });
    if (!user) return res.status(400).json({ success: false, message: "유저 없음" });
    
    // 보상 지급 (500P)
    user.points += 500;
    await user.save();

    // 핀 삭제 (미션 완료)
    await Pin.findByIdAndDelete(pinId);
    
    io.emit('removePin', pinId);
    
    // 응답 메시지 다르게 주기
    const msg = photo ? "사진 인증 성공! 500P 지급됨!" : "답변 등록 성공! 500P 지급됨!";
    res.json({ success: true, newPoints: user.points, message: msg });
  } catch (err) {
    res.status(500).json({ success: false, message: "서버 오류" });
  }
});

io.on('connection', async (socket) => {
  const activePins = await Pin.find();
  socket.emit('loadPins', activePins);

  socket.on('bossSignal', async (data) => {
    const newPin = new Pin({
      lat: data.lat, lng: data.lng, type: data.type, message: data.message, storeName: data.storeName, username: data.username
    });
    const savedPin = await newPin.save();
    io.emit('newSignal', savedPin);
  });

  socket.on('deletePin', async (pinId) => {
    await Pin.findByIdAndDelete(pinId);
    io.emit('removePin', pinId);
  });
});

const port = process.env.PORT || 3000;
server.listen(port, () => { console.log(`🚀 BluePin V10.3 Hybrid Server: ${port}`); });
