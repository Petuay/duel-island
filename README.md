# Duel Island

เกม 3 มิติมุมสูง ให้ผู้เล่นแอบเดินหาจุดยืน+ทิศทางบนเกาะ แล้วยิงพร้อมกันตอนหมดเวลา เกาะจะเล็กลงทุกรอบจนเหลือผู้รอดคนเดียว

## รันบนเครื่องตัวเอง

```
npm install
npm start
```

เปิด `http://localhost:3000`

## Deploy ขึ้น Render (ฟรี)

1. Push โปรเจกต์นี้ขึ้น GitHub repo
2. เข้า https://render.com สมัคร/ล็อกอินด้วยบัญชี GitHub
3. New > Blueprint > เลือก repo นี้ (จะอ่านค่าใน `render.yaml` ให้อัตโนมัติ) หรือเลือก New > Web Service แล้วตั้งค่าเอง:
   - Build Command: `npm install`
   - Start Command: `npm start`
4. รอ deploy เสร็จ จะได้ URL แบบ `https://duel-island-xxxx.onrender.com` ส่งให้เพื่อนเข้าเล่นได้ทันที

> หมายเหตุ: free tier ของ Render จะ sleep เมื่อไม่มีคนใช้งาน ทำให้การเปิดครั้งแรกช้าประมาณ 30-60 วินาที
