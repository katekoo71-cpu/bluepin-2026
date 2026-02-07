const express = require('express');
const app = express();
const http = require('http');
const server = http.createServer(app);
const { Server } = require("socket.io");
const io = new Server(server);
const mongoose = require('mongoose');

const MONGO_URI = "mongodb+srv://bluepinadmin:bluepinadmin1234@cluster0.3pq60lz.mongodb.net/?retryWrites=true&w=majority&appName=Cluster0";

mongoose.connect(MONGO_URI)
  .then(() => console.log('✅ MongoDB 연결 성공!'))
  .catch(err => console.log('🔥 DB 연결 실패:', err));

const pinSchema = new mongoose.Schema({
  lat: Number, lng: Number, type: String, message: String, storeName: String,
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

app.use(express.json());
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
    res.json({ success: true, message: "가입 성공! (손님은 1000P 지급됨)" });
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
    if (!user) return res.status(400).json({ success: false, message: "유저 찾기 실패" });
    if (user.points >= 1000) {
      user.points -= 1000;
      await user.save();
      res.json({ success: true, newPoints: user.points, message: "사용 완료! (잔액: " + user.points + ")" });
    } else { res.json({ success: false, message: "잔액이 부족합니다! (필요: 1000 BP)" }); }
  } catch (err) { res.status(500).json({ success: false, message: "서버 오류" }); }
});

io.on('connection', async (socket) => {
  const activePins = await Pin.find();
  socket.emit('loadPins', activePins);

  socket.on('bossSignal', async (data) => {
    const newPin = new Pin({
      lat: data.lat, lng: data.lng, type: data.type, message: data.message, storeName: data.storeName
    });
    const savedPin = await newPin.save(); // 저장된 객체 받기 (ID 포함)
    
    // ★ 저장된 핀 정보(ID 포함)를 모두에게 전송
    io.emit('newSignal', savedPin);
  });

  // ★ [NEW] 핀 삭제 기능
  socket.on('deletePin', async (pinId) => {
    console.log('🗑 핀 삭제 요청:', pinId);
    await Pin.findByIdAndDelete(pinId); // DB에서 삭제
    io.emit('removePin', pinId);        // 모두에게 "이 핀 지워!" 방송
  });
});

const port = process.env.PORT || 3000;
server.listen(port, () => { console.log(`🚀 BluePin V9.0 Server Started: ${port}`); });
