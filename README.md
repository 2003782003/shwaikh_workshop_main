# ورشة شويخ - نظام إدارة تصليح المحركات

## نظرة عامة
- **الاسم**: ورشة شويخ (Chouikh Workshop)
- **الهدف**: تطبيق ويب متكامل لمتابعة تصليح المحركات يربط بين الزبائن والفنيين والمدير عبر لوحات تحكم مخصصة
- **التقنيات**: Hono + TypeScript + Cloudflare Pages + D1 (SQLite) + TailwindCSS
- **النمط المعماري**: MVC (Models = جداول D1 + استعلامات، Views = SPA HTML/JS، Controllers = مسارات Hono)

## الميزات الحالية ✅
- تسجيل دخول آمن بـ SHA-256 و Session Cookies
- إنشاء حساب زبون ذاتياً
- ثلاث أدوار: المدير / الفني / الزبون — كل دور له قائمة تنقل خاصة
- لوحة تحكم الزبون بأربع أقسام ملونة (جاهزة / قيد التصليح / سجل / ديون)
- لوحة تحكم الفني والمدير مع إحصائيات وآخر المحركات
- إضافة محرك مع بحث تلقائي عن الزبون + إدراج صور العطل + قائمة قطع غيار ديناميكية
- نظام مراسلة فوري (Polling كل 5 ثوان) بين الزبون والورشة مع مشاركة صور
- إدارة قطع الغيار (CRUD)
- إدارة الديون مع تتبّع السعر النهائي والمبلغ المدفوع وحالة الدفع (مسبق/في الموعد/متأخر)
- إرسال تذكيرات للزبائن المدينين (إشعار فوري + خيار أسبوعي/شهري)
- تقارير رسومية (Chart.js): حالة المحركات + نشاط الأشهر الأخيرة
- إدارة المستخدمين من قبل المدير (إضافة/تعديل/حذف فنيين وزبائن)
- نسخ احتياطي كامل لقاعدة البيانات بصيغة JSON (للمدير فقط)
- إشعارات ظاهرة في القائمة الجانبية (حواسيب) وأيقونة (هواتف)
- تصميم متجاوب RTL مع خط Cairo
- لوغو PNG مخصص (تروس + مفاتيح ميكانيكية بألوان أزرق ملكي وذهبي) + PWA Manifest
- العملة: الدينار الجزائري (دج)
- قسم تسليم المحركات الجاهزة بصفحة منفصلة + نموذج تسليم تفاعلي
- نموذج "تم التصليح" يفتح Popup يحوي السعر النهائي + ملاحظات التصليح
- قسم الديون المعاد تصميمه: 3 إحصائيات ملوّنة، شريط تقدّم لكل زبون، أزرار دفع/تذكير/مراسلة

## ✨ ميزات الإدارة المتقدمة (الجديد)

### 👤 الملف الشخصي للمدير
- صفحة "الملف الشخصي" منفصلة في القائمة الجانبية للمدير
- عرض البيانات: الاسم الكامل، الدور، اسم المستخدم، الهاتف، تاريخ إنشاء الحساب
- نموذج تغيير كلمة المرور بالحقول التالية:
  * كلمة المرور الحالية (مع التحقق على الخادم)
  * كلمة المرور الجديدة (≥ 8 أحرف، حرف كبير + صغير + رقم + رمز خاص)
  * تأكيد كلمة المرور (تحقق التطابق على الواجهة)
- زر "تحديث كلمة المرور" مع مؤشر تحميل ورسائل نجاح/فشل واضحة
- عرض **تاريخ آخر تعديل لكلمة المرور** (عمود `password_updated_at`)

### 🗑️ حذف الزبائن (Soft-Delete + Audit)
- زر "سلة مهملات" بجانب كل زبون (للمدير فقط)
- نافذة تأكيد منبثقة تُظهر: اسم الزبون، المعرّف، تحذير "لا يمكن التراجع"
- زرّا "إلغاء" / "تأكيد الحذف" مع مؤشر تحميل
- التنفيذ عبر **soft-delete**: تعيين `deleted_at`, `deleted_by`, `is_active=0`
- إخفاء الزبون من جميع القوائم والإحصائيات تلقائياً
- تسجيل العملية في **سجل التدقيق** (action, target, actor, timestamp)

### 🔧 حذف الفنيين (مع منع الفقدان)
- نفس واجهة حذف الزبائن مع منطق إضافي على الخادم:
  * **منع الحذف** إذا كان الفني مرتبط بمهام نشطة (status ≠ delivered)
  * إذا كانت **المهام سابقة فقط**: يُعرض خياران:
    - **نقل المهام إلى فني آخر** (قائمة منسدلة)، ثم حذف
    - **إلغاء الحذف**
  * تعطيل الحساب (`is_active=0`) قبل الحذف النهائي (soft-delete)
- تسجيل كامل في سجل التدقيق

### ⚙️ حذف/أرشفة المحركات
- زر حذف على كل محرك في قائمة المحركات + إجراءات الإدارة في نافذة التفاصيل
- التحقق على الخادم عبر `GET /api/engines/:id/delete-impact`:
  * هل توجد **دفعات مسجّلة**؟
  * هل تم **التسليم**؟
  * هل توجد **تقارير صيانة**؟
  * هل يؤثر على الإحصائيات؟
- تقرير تأثير مرئي (4 بطاقات ملوّنة) داخل نافذة الحذف
- خيار "**أرشفة بدلاً من الحذف**" (موصى به للمحركات ذات سجل تاريخي):
  * `is_archived=1`, `archived_at`, `archived_by`, `archive_reason`
  * يُستثنى من الإحصائيات والقوائم لكن يبقى للتقارير التاريخية
  * فلتر "الأرشيف" (للمدير) في قائمة المحركات لرؤيتها واسترجاعها
- زر "إلغاء الأرشفة" في نافذة التفاصيل
- حقل **سبب الحذف** إجباري للمحركات ذات سجل تاريخي

### 📋 سجل التدقيق (Audit Log)
- جميع عمليات الحذف، الأرشفة، تغيير كلمات المرور، نقل المهام، تسجيل الدخول، تُسجَّل في جدول `audit_log`
- صفحة عرض في القائمة الجانبية للمدير: "سجل التدقيق"
- يُظهر: نوع العملية، الهدف، المسؤول، التاريخ، التفاصيل (JSON)
- تصفية وتقسيم صفحات

## URIs و API (المسارات)

### المصادقة والملف الشخصي
- `POST /api/auth/login` { username, password }
- `POST /api/auth/register` { username, password, full_name, phone } (زبون فقط)
- `POST /api/auth/logout`
- `GET /api/auth/me`
- `GET /api/auth/profile` ← يعيد الملف الشخصي + `password_updated_at`
- `POST /api/auth/change-password` { current_password, new_password }

### المستخدمون (إدارة)
- `GET /api/users?role=&q=&include_inactive=1`
- `POST /api/users` (admin) { username, password, role, full_name, phone, notify_frequency }
- `PUT /api/users/:id` (admin)
- `DELETE /api/users/:id` (admin) ← soft-delete
- `GET /api/users/:id/delete-impact` (admin) ← يُظهر المهام النشطة/التاريخية
- `POST /api/users/:id/transfer-tasks` (admin) { to_user_id }

### المحركات
- `GET /api/engines?status=&archived=1`
- `GET /api/engines/:id`
- `POST /api/engines` (staff)
- `PUT /api/engines/:id` (staff)
- `DELETE /api/engines/:id?reason=&force=1` (admin)
- `GET /api/engines/:id/delete-impact` (admin) ← تقرير تأثير الحذف
- `POST /api/engines/:id/archive` (admin) { reason }
- `POST /api/engines/:id/unarchive` (admin)

### الرسائل والإشعارات
- `GET /api/messages/conversations`
- `GET /api/messages?with=USER_ID`
- `POST /api/messages` { to_user_id, body, image_url }
- `GET /api/messages/unread-count`
- `GET /api/notifications`
- `POST /api/notifications/read`

### الديون
- `GET /api/debts`
- `POST /api/debts/pay` (staff) { engine_id, amount, payment_status }
- `POST /api/debts/remind` (staff) { customer_id }

### قطع الغيار
- `GET /api/spare-parts`, `POST`, `PUT /api/spare-parts/:id`, `DELETE /api/spare-parts/:id`

### التقارير وسجل التدقيق والنسخ الاحتياطي
- `GET /api/stats` (staff)
- `GET /api/reports` (staff)
- `GET /api/audit-log?action=&limit=&offset=` (admin)
- `GET /api/backup` (admin — يُنزّل JSON)

## بنية قاعدة البيانات (D1 SQLite)

### الجداول الأساسية
- `users` — المستخدمون (admin/technician/customer) + تجزئة كلمة المرور + notify_frequency
  + الأعمدة المضافة: `password_updated_at`, `is_active`, `deleted_at`, `deleted_by`
- `engines` — المحركات (status, payment_status, entry/expected/delivered dates, prices, parts_list JSON)
  + الأعمدة المضافة: `repair_notes`, `is_archived`, `archived_at`, `archived_by`, `archive_reason`
- `messages` — الرسائل (from/to/body/image_url/engine_id/is_read)
- `notifications` — الإشعارات (type: status/debt/message/info)
- `spare_parts` — قطع الغيار (name/quantity/price)
- `repair_reports` — تقارير الإصلاح
- `sessions` — جلسات الدخول
- `backups` — سجلّ النسخ الاحتياطية
- **`audit_log`** (جديد) — سجل تدقيق العمليات الحساسة (id, actor_id, action, target_type, target_id, details JSON, created_at)

### الترحيلات (Migrations)
- `0001_initial_schema.sql` — البنية الأساسية
- `0002_repair_notes.sql` — حقل ملاحظات التصليح
- `0003_admin_features.sql` — Audit log + soft-delete + archive + password tracking

## بيانات تجريبية
- **المدير**: `admin` / `Admin@123` (تم تحديثها لتمتثل لقواعد كلمة المرور القوية)
- **الفني**: `technician` / `tech123`
- **الزبون**: `customer1` / `customer123`

## دليل الاستخدام
1. افتح الرابط وسجّل الدخول باستخدام أحد الحسابات التجريبية، أو اضغط "إنشاء حساب زبون".
2. **كزبون**: تابع محركاتك عبر لوحة التحكم ذات الأقسام الأربعة، أو افتح تفاصيل محرك، أو راسل الورشة، أو تابع ديونك.
3. **كفنّي/مدير**: أضف محركاً جديداً، تابع حالات الإصلاح، سجّل المدفوعات، أرسل تذكيرات للزبائن المدينين، اعرض التقارير.
4. **كمدير فقط**:
   - **الملف الشخصي**: غيّر كلمة المرور برسائل تأكيد فورية ورؤية تاريخ آخر تعديل.
   - **إدارة المستخدمين**: زر سلة المهملات لكل زبون/فني → نافذة تأكيد قبل الحذف.
   - **إدارة المحركات**: زر "حذف" يفتح تقرير تأثير + خيار أرشفة بدلاً من الحذف.
   - **سجل التدقيق**: عرض جميع العمليات الحساسة الموثّقة.
   - **النسخ الاحتياطي**: تنزيل JSON كامل.

## الأمان
- كلمات المرور مُجزّأة بـ SHA-256 (Web Crypto API)
- Session tokens عشوائية 256-bit
- HttpOnly cookies + SameSite=Lax
- Role-based authorization على جميع نقاط النهاية
- **التحقق من صلاحيات المدير قبل أي عملية حذف**
- **سجل تدقيق غير قابل للتعديل** لكل عملية حذف/أرشفة/تغيير كلمة مرور
- **سياسة كلمة مرور قوية**: ≥ 8 أحرف، حروف كبيرة وصغيرة، أرقام، رموز خاصة (يُتحقق منها على الخادم)

## نمط MVC
- **Model** — `migrations/*.sql` + استعلامات `c.env.DB.prepare(...)` المغلَّفة في معالِجات Hono
- **View** — `public/static/app.js` (SPA) + `src/views.ts` (HTML shell) + `public/static/styles.css`
- **Controller** — `src/index.tsx` (مسارات Hono) + `src/auth.ts` (Middleware + helpers صلاحيات)

## التطوير محلياً
```bash
npm run build
npx wrangler d1 migrations apply webapp-production --local
pm2 start ecosystem.config.cjs
# يشتغل على http://localhost:3000
```

## النشر
- **المنصّة**: Cloudflare Pages
- **قاعدة البيانات**: Cloudflare D1
- **الحالة**: ✅ جاهز للنشر
- **آخر تحديث**: 2026-04-30

## الميزات غير المنفّذة بعد
- استرجاع البيانات بعد الحذف (Restore from soft-delete) — حالياً يدوي عبر SQL فقط
- تصدير سجل التدقيق إلى CSV/PDF
- إشعارات Push عبر متصفح (Web Push)
- مصادقة ثنائية (2FA) للمدير

## التوصيات للتطوير القادم
1. إضافة واجهة استرجاع للزبائن/الفنيين/المحركات المحذوفة
2. تنبيهات بريد إلكتروني عند تغيير كلمة المرور أو الحذف
3. صفحات إحصائيات Audit (مَن حذف ماذا/متى) ضمن التقارير
4. اختبارات Unit + E2E (vitest + playwright)
5. ربط reCAPTCHA على نموذج تسجيل الدخول
