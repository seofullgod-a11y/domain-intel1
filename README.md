# 🌐 DomainIntel — SEO Domain Intelligence Dashboard

ระบบ Dashboard สำหรับติดตามโดเมนพันๆ ตัว ครบจบในที่เดียว

---

## ✅ ฟีเจอร์ทั้งหมด

| ฟีเจอร์ | รายละเอียด |
|---------|-----------|
| 🔴 Domain Status | เช็ค Up/Down/Warning แบบ Real-time |
| 📊 Google Search Console | Clicks, Impressions, Avg Position, Keywords |
| 🏆 Keyword Rankings | ดู Top Keyword และ Position ของทุกโดเมน |
| 📅 Domain Expiry | เช็ควันหมดอายุ แจ้งเตือนล่วงหน้า |
| 📥 Bulk Import CSV | นำเข้าโดเมนพันๆ ตัวด้วย CSV เดียว |
| 🔔 LINE Notify | แจ้งเตือนทันทีที่โดเมนล่ม |
| ⚡ Auto-check | เช็คอัตโนมัติทุก 30 นาที |
| 📤 Export CSV | Export ข้อมูลทั้งหมดออกได้ตลอดเวลา |
| 🔍 Filter & Search | กรอง/ค้นหา/Sort ได้ทุก column |

---

## 🚀 วิธีติดตั้งและรัน

### ความต้องการ
- Node.js v16+ ([nodejs.org](https://nodejs.org))
- ไม่ต้องติดตั้ง library ใดเพิ่ม (ใช้ built-in modules ทั้งหมด)

### ขั้นตอน

```bash
# 1. เข้าไปในโฟลเดอร์
cd domain-intel

# 2. รัน Server
node server.js

# 3. เปิด Browser ไปที่
http://localhost:3001
```

ถ้าต้องการรันตลอดเวลา (Production):
```bash
# ใช้ PM2
npm install -g pm2
pm2 start server.js --name domain-intel
pm2 save
pm2 startup
```

---

## 🔗 การเชื่อมต่อ Google Search Console API

### ขั้นตอน (ทำครั้งเดียว)

1. ไปที่ [Google Cloud Console](https://console.cloud.google.com/)
2. สร้าง Project ใหม่ หรือเลือก Project ที่มีอยู่
3. ไปที่ **APIs & Services → Enable APIs** → ค้นหา **"Search Console API"** → Enable
4. ไปที่ **APIs & Services → Credentials → Create Credentials → OAuth 2.0 Client ID**
   - Application type: **Web application**
   - Authorized redirect URIs: `https://developers.google.com/oauthplayground`
5. คัดลอก **Client ID** และ **Client Secret**

### ขอ Refresh Token

1. ไปที่ [OAuth 2.0 Playground](https://developers.google.com/oauthplayground/)
2. คลิกไอคอน ⚙️ ด้านบนขวา → เปิด "Use your own OAuth credentials"
3. ใส่ Client ID และ Client Secret
4. ใน Step 1 พิมพ์ scope: `https://www.googleapis.com/auth/webmasters.readonly`
5. คลิก **Authorize APIs** → อนุญาต Google Account
6. ใน Step 2 คลิก **Exchange authorization code for tokens**
7. คัดลอก **Refresh Token**

### ใส่ใน Dashboard

เปิด Dashboard → Settings → Google Search Console API → ใส่ Client ID, Client Secret, Refresh Token → บันทึก

---

## 🔔 การตั้งค่า LINE Notify

1. ไปที่ [LINE Notify](https://notify-bot.line.me/th/)
2. Login ด้วย LINE Account
3. คลิก **Generate token**
4. เลือก Group หรือ 1:1 ที่ต้องการรับแจ้งเตือน
5. คัดลอก Token → ใส่ใน Dashboard → Settings → LINE Notify Token

---

## 📥 Format CSV สำหรับ Import

```csv
domain,notes,tags,expiry_date,days_left
example.com,เว็บหลัก,seo;lead,2026-12-31,217
example2.net,แคมเปญ Q1,ppc,2026-06-30,32
myblog.co.th,บล็อก SEO,seo;content,2027-01-15,232
```

**คำอธิบาย column:**
- `domain` — ชื่อโดเมน (จำเป็น) เช่น `example.com`
- `notes` — หมายเหตุ (ถ้ามี)
- `tags` — tag คั่นด้วย `;` เช่น `seo;lead;ppc`
- `expiry_date` — วันหมดอายุ format `YYYY-MM-DD`
- `days_left` — วันที่เหลือ (คำนวณจาก expiry_date ได้เลย)

---

## 🔌 API Endpoints

| Method | Endpoint | รายละเอียด |
|--------|----------|-----------|
| GET | `/api/domains` | ดึงโดเมนทั้งหมด |
| GET | `/api/stats` | สถิติสรุป |
| POST | `/api/domains/add` | เพิ่มโดเมนใหม่ |
| POST | `/api/domains/import` | Import CSV |
| DELETE | `/api/domains/:domain` | ลบโดเมน |
| POST | `/api/check/:domain` | เช็คสถานะโดเมนเดี่ยว |
| POST | `/api/check-all` | เช็คทุกโดเมน |
| POST | `/api/gsc/sync/:domain` | Sync GSC โดเมนเดี่ยว |
| POST | `/api/gsc/sync-all` | Sync GSC ทุกโดเมน |
| GET/POST | `/api/config` | ดู/แก้ไข Config |
| POST | `/api/whois/:domain` | เช็ควันหมดอายุ (WHOIS) |

---

## 📁 โครงสร้างไฟล์

```
domain-intel/
├── server.js          # Backend API server
├── package.json
├── public/
│   └── index.html     # Frontend Dashboard
├── data/
│   ├── domains.json   # ข้อมูลโดเมนทั้งหมด (auto-generated)
│   ├── config.json    # GSC API keys, LINE token (auto-generated)
│   └── template.csv   # ตัวอย่าง CSV template
└── README.md
```

---

## ⚡ Performance สำหรับโดเมนพันๆ ตัว

- Server เช็คโดเมนพร้อมกัน **20 ตัวต่อครั้ง** (Batch)
- GSC Sync รันแบบ **Background** ไม่บล็อก UI
- Frontend แสดงผล **25 โดเมนต่อหน้า** (Pagination)
- ข้อมูลเก็บใน JSON file (ปรับเป็น SQLite/MySQL ได้ง่าย)

สำหรับโดเมน 1,000 ตัว:
- เช็ค Status ทั้งหมด ≈ 3–5 นาที
- GSC Sync ≈ 10–20 นาที (ขึ้นกับ API rate limit)

---

## 🛠️ แนะนำ Upgrade เพิ่มเติม

- [ ] เพิ่ม **SQLite** แทน JSON สำหรับ performance
- [ ] เพิ่ม **Email Alert** (Nodemailer)
- [ ] เพิ่ม **Historical Chart** แสดง Traffic ย้อนหลัง
- [ ] เพิ่ม **Ahrefs / SEMrush API** สำหรับ Backlink data
- [ ] Deploy บน **VPS / Railway / Render** เพื่อให้รันตลอดเวลา
