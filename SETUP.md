# راه‌اندازی از صفر روی یک دستگاه جدید

این راهنما برای کسی است که فقط این پوشه را تحویل گرفته و می‌خواهد بات را راه بیندازد.

بات یک **کلاینت واقعی تیم‌اسپیک** را کنترل می‌کند، پس مثل یک کاربر عادی برای همه دیده می‌شود.
هیچ یوزر و پسورد ServerQuery لازم ندارد.

---

## فایل‌هایی که باید کپی شوند

```
bot.js                 منطق بات
clientquery.js         ماژول پروتکل
config.json            تنظیمات  ← این را ویرایش می‌کنید
start.bat              اجرا
set-group-display.js   یک‌بار اجرا: تگ [CMT Server] و ترتیب کاربران
test-logic.js          تست‌ها (اختیاری)
cq-probe.js            تست زنده (اختیاری)
package.json           فقط برای npm start
README.md / SETUP.md   راهنما
```

پوشه `node_modules` **لازم نیست** — این پروژه هیچ وابستگی خارجی ندارد و `npm install` نمی‌خواهد.

---

## مرحله ۱ — Node.js

از [nodejs.org](https://nodejs.org) نسخه LTS را نصب کنید. تست:

```
node --version
```

اگر شناخته نشد، `start.bat` خودش سراغ `C:\Program Files\nodejs\node.exe` می‌رود.

## مرحله ۲ — کلاینت تیم‌اسپیک ۳

۱. کلاینت TS3 را روی **همان دستگاهی که بات اجرا می‌شود** نصب کنید.
۲. کلاینت را باز کنید و با همان **identity** که قرار است بات باشد به سرور وصل شوید.
۳. مطمئن شوید افزونه **ClientQuery** فعال است: `Tools → Options → Addons → Plugins`.
   وقتی فعال باشد روی `127.0.0.1:25639` گوش می‌دهد.
۴. روی سرور راست‌کلیک → **Subscribe to all channels** (برای حذف خودکار رول لازم است).

> **کلاینت باید همیشه باز بماند.** روی ویندوز سرور، سشن RDP را **disconnect** کنید
> نه **log off** — لاگ‌آف کلاینت را می‌بندد و بات می‌خوابد.

API key خودکار از این مسیر خوانده می‌شود و نیازی به کپی کردنش نیست:

```
%APPDATA%\TS3Client\clientquery.ini
```

اگر کلاینت جای دیگری نصب شده، مسیر را در `clientquery.apiKeyFile` بگذارید.

## مرحله ۳ — رول بات

بات با پرمیشن‌های همان کاربری کار می‌کند که کلاینت با آن وصل شده. به آن identity یک سرور گروپ
بدهید که این‌ها را داشته باشد:

| پرمیشن | برای چه |
|---|---|
| `i_group_member_add_power` | دادن رول (باید از `i_group_needed_member_add_power` رول CMT بیشتر باشد) |
| `i_group_member_remove_power` | گرفتن رول |
| `b_virtualserver_servergroup_client_list` | لیست اعضا و اسم چنل‌ها |
| `b_virtualserver_client_dblist` | پیدا کردن کاربر آفلاین |
| `b_channel_modify_name` + `i_channel_modify_power` | تغییر اسم چنل‌ها |
| `i_client_move_power` | انتقال به چنل AFK |
| `b_client_server_textmessage_send` / `b_client_channel_textmessage_send` | جواب دادن در چت |
| `i_group_needed_modify_power` کمتر از قدرت بات | اجرای `set-group-display.js` |

## مرحله ۴ — اطلاعات سرور در کانفیگ

`config.json` را باز کنید:

```jsonc
"teamspeak": {
  "host": "1.2.3.4",          // فقط آی‌پی، بدون پورت
  "serverport": 9987,         // پورت ویرچوال سرور
  "nickname": "Sun Bot",      // اسمی که همه می‌بینند
  "serverPassword": "",       // اگر سرور پسورد دارد، اینجا
  "defaultChannelId": 0,      // بات در این چنل بنشیند (0 = هرجا بود)
  "autoConnect": true
}
```

## مرحله ۵ — اولین اجرا برای گرفتن آی‌دی‌ها

`start.bat` را اجرا کنید. بات وصل می‌شود و **لیست کامل سرور گروپ‌ها با آی‌دی** را چاپ می‌کند:

```
available server groups:
    sgid=11  Guest
    sgid=91  CMT Server
    sgid=92  CMT Ticket
```

آی‌دی چنل‌ها را هم از کلاینت بگیرید: راست‌کلیک روی چنل → **Edit Channel** → قسمت **Channel ID**.

### بردن رول‌های CMT به سرور جدید

اگر رول‌های CMT روی سرور جدید وجود ندارند، لازم نیست چیزی export کنید:

```
node create-cmt-groups.js --dry     ببینید چه کار می‌کند
node create-cmt-groups.js           بسازد
```

رول‌های CMT فقط ۳ پرمیشن دارند، پس ساختنشان از صفر چند ثانیه است. اسکریپت اگر گروهی با همان
اسم وجود داشته باشد دست نمی‌زند، و آخرش آی‌دی‌ها را برای `config.json` چاپ می‌کند.

آیکون گروه منتقل نمی‌شود — آیکون‌ها در فایل‌ریپازیتوری خود سرور ذخیره می‌شوند، پس آی‌دی آیکون
سرور دیگر روی این سرور به هیچی اشاره نمی‌کند. اگر آیکون می‌خواهید، از کلاینت ست کنید.

> **درباره Snapshot:** تیم‌اسپیک قابلیت `serversnapshotcreate` / `serversnapshotdeploy` دارد که
> کل ویرچوال سرور را کپی می‌کند. ولی deploy کردن اسنپ‌شات، سرور مقصد را **کامل پاک و بازنویسی
> می‌کند** — همه چنل‌ها، رول‌ها و دیتابیس کاربران. برای بردن دو تا رول هرگز از آن استفاده نکنید.

## مرحله ۶ — آی‌دی‌ها را در کانفیگ بگذارید

```jsonc
"groups": {
  "cmtserver": 91,
  "cmtticket": 92
},
"channels": {
  "cmtserver": 86,      // چنلی که اسمش می‌شود "CMT Server : ..."
  "cmtticket": 87
},
"afk": {
  "channelId": 44       // چنل AFK
}
```

> **مهم:** این آی‌دی‌ها روی هر سرور فرق می‌کنند. آی‌دی‌های سرور قبلی به درد سرور جدید نمی‌خورند.

## مرحله ۷ — اجرای دوباره

`start.bat` را ببندید و دوباره باز کنید. باید ببینید:

```
on the server as "Sun Bot" clid=5 cldbid=66
groups.cmtserver = 91 ("CMT Server")
auto-remove on leave is enabled.
AFK: moving to channel 44 after 5s of "deaf", checked every 2s.
ready - listening for chat commands.
```

## مرحله ۸ — تگ `[CMT Server]` و ترتیب کاربران (یک‌بار)

```
node set-group-display.js --talk 50
```

- تگ `[CMT Server]` کنار اسم اعضا می‌آورد
- به اعضا Talk Power می‌دهد تا بالای بقیه در چنل قرار بگیرند

برای دیدن وضعیت فعلی: `node set-group-display.js --show`
برای برگرداندن: `node set-group-display.js --mode 0 --talk 0`

---

## تست

```
node test-logic.js     ۶۷ تست آفلاین، بدون نیاز به سرور
node cq-probe.js       تست زنده کل زنجیره روی سرور واقعی
```

`cq-probe.js` یک رول به خود بات می‌دهد، تأیید می‌کند، اسم چنل را عوض می‌کند و آخرش
همه‌چیز را برمی‌گرداند — پس روی کسی اثر نمی‌گذارد.

---

## چند کانفیگ همزمان

اگر می‌خواهید یک سرور تست و یک سرور اصلی داشته باشید، فایل‌ها را جدا نگه دارید:

```
set CMT_CONFIG=C:\TS\config.main.json
node bot.js
```

بدون این متغیر، همان `config.json` کنار `bot.js` خوانده می‌شود.

---

## اگر بالا نیامد

| پیام | یعنی |
|---|---|
| `could not reach the ClientQuery plugin` | کلاینت TS3 باز نیست یا افزونه ClientQuery فعال نیست |
| `could not read the ClientQuery api key` | مسیر `clientquery.ini` را در `clientquery.apiKeyFile` بدهید |
| `the client did not finish connecting` | آی‌پی/پورت غلط، پسورد سرور غلط، یا آی‌پی بن/بلک‌لیست شده |
| `no server group with sgid X exists` | آی‌دی رول در `groups` مال سرور دیگری است |
| `could not rename channel X` | آی‌دی چنل غلط، اسم تکراری، یا نداشتن `b_channel_modify_name` |
| رول داده نمی‌شود | `i_group_member_add_power` بات کمتر از نیاز رول CMT است |
| `skipping auto-remove` | **Subscribe to all channels** را در کلاینت فعال کنید |

جزئیات کامل هر قابلیت در `README.md` است.
