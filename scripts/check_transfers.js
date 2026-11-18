const puppeteer = require('puppeteer');
const axios = require('axios');
const fs = require('fs');
const path = require('path');

// ================= 設定區 =================
const TARGET_URL = 'https://helper.lineagem.cc/id/';
const WATCH_SERVERS = ['伊娃']; 

const DISCORD_WEBHOOK_URL = process.env.DISCORD_WEBHOOK_URL;
const DISCORD_MESSAGE_ID = process.env.DISCORD_MESSAGE_ID;
const HISTORY_FILE = path.join(__dirname, '../data/notified_history.json');
// ==========================================

async function run() {
    if (!DISCORD_WEBHOOK_URL || !DISCORD_MESSAGE_ID) {
        console.error('❌ 錯誤：請確認已設定 DISCORD_WEBHOOK_URL 與 DISCORD_MESSAGE_ID');
        process.exit(1);
    }

    // 1. 讀取已通知過的歷史紀錄，並處理「每週三 18:00 重置」邏輯
    let notifiedHistory = [];
    
    // 取得目前台灣時間
    const now = new Date();
    const twTime = new Date(now.toLocaleString("en-US", { timeZone: "Asia/Taipei" }));
    const dayOfWeek = twTime.getDay(); // 0 = 週日, 3 = 週三
    const hour = twTime.getHours();

    // 判斷邏輯：如果今天是週三，且時間剛過或等於 18:00
    // 我們可以檢查紀錄檔案的最後修改時間，如果它是週三 18:00 之前的檔案，就自動歸零重置！
    let shouldReset = false;
    if (fs.existsSync(HISTORY_FILE)) {
        const stats = fs.statSync(HISTORY_FILE);
        const fileMtime = new Date(stats.mtime.toLocaleString("en-US", { timeZone: "Asia/Taipei" }));
        
        // 簡單判定：若目前是週三 18:00 以後，但檔案修改時間是在本週三 18:00 之前，代表這是上週的舊資料，進行重置
        if (dayOfWeek === 3 && hour >= 18) {
            const wednesday18 = new Date(twTime);
            wednesday18.setHours(18, 0, 0, 0);
            if (fileMtime < wednesday18) {
                shouldReset = true;
                console.log('🔄 偵測到每週三 18:00 過後，自動清空上週的移民歷史紀錄以配合官方重置！');
            }
        }
    }

    if (!shouldReset && fs.existsSync(HISTORY_FILE)) {
        notifiedHistory = JSON.parse(fs.readFileSync(HISTORY_FILE, 'utf8'));
    } else {
        notifiedHistory = []; // 歸零
    }

    console.log('🚀 啟動瀏覽器抓取最新移民名單...');
    const browser = await puppeteer.launch({
        headless: 'new',
        args: ['--no-sandbox', '--disable-setuid-sandbox']
    });
    const page = await browser.newPage();
    await page.goto(TARGET_URL, { waitUntil: 'networkidle2', timeout: 60000 });

    // 2. 點擊左側選單的「本週移民」按鈕
    await page.evaluate(() => {
        const elements = Array.from(document.querySelectorAll('a, button, div, span'));
        const transferBtn = elements.find(el => el.textContent.trim() === '本週移民');
        if (transferBtn) transferBtn.click();
    });

    await new Promise(r => setTimeout(r, 3000));

    // 3. 解析表格資料
    const transfers = await page.evaluate(() => {
        const rows = Array.from(document.querySelectorAll('table tbody tr'));
        return rows.map(row => {
            const cols = Array.from(row.querySelectorAll('td')).map(td => td.innerText.trim());
            if (cols.length < 6) return null;
            return {
                job: cols[0],
                player: cols[1],
                targetServer: cols[2],
                serverGroup: cols[3],
                prevName: cols[4],
                prevServer: cols[5]
            };
        }).filter(item => item !== null && item.player !== '');
    });

    await browser.close();
    console.log(`📊 共抓取到 ${transfers.length} 筆移民資料。`);

    // 4. 篩選看板資料 & 過濾出尚未通知過的新警報
    const incomingList = transfers.filter(t => WATCH_SERVERS.includes(t.targetServer));
    const outgoingList = transfers.filter(t => WATCH_SERVERS.includes(t.prevServer));
    const newAlerts = [];

    for (const item of transfers) {
        if (WATCH_SERVERS.includes(item.targetServer)) {
            const recordKey = `IN_${item.player}_${item.targetServer}_${item.prevServer}`;
            if (!notifiedHistory.includes(recordKey)) {
                newAlerts.push({ ...item, alertType: 'IN', recordKey });
                notifiedHistory.push(recordKey);
            }
        }
        if (WATCH_SERVERS.includes(item.prevServer)) {
            const recordKey = `OUT_${item.player}_${item.targetServer}_${item.prevServer}`;
            if (!notifiedHistory.includes(recordKey)) {
                newAlerts.push({ ...item, alertType: 'OUT', recordKey });
                notifiedHistory.push(recordKey);
            }
        }
    }

    // ========================================================
    // 動作 A：原地更新【戰情狀態看板】
    // ========================================================
    const nowUnix = Math.floor(Date.now() / 1000);
    const incomingText = incomingList.length > 0
        ? incomingList.slice(0, 15).map(item => 
            `🔴 **${item.player}** (${item.job}) ➔ 進入【${item.targetServer}】 *(原: ${item.prevServer})*`
          ).join('\n')
        : '目前監控伺服器無新增移入紀錄';

    const outgoingText = outgoingList.length > 0
        ? outgoingList.slice(0, 15).map(item => 
            `🟡 **${item.player}** (${item.job}) ➔ 離開【${item.prevServer}】前往【${item.targetServer}】`
          ).join('\n')
        : '目前監控伺服器無人員移出紀錄';

    const dashboardPayload = {
        username: "SkyNet 移民雷達",
        embeds: [
            {
                title: "📡 本週移民監控狀態看板",
                color: 5763719,
                description: 
                    `📡 雷達掃描狀態：最後更新 <t:${nowUnix}:R>\n` +
                    `📊 全服總移民數：**${transfers.length}** 筆 | 監控相關：**${incomingList.length + outgoingList.length}** 筆\n` +
                    `🔍 看板限定伺服器：\`${WATCH_SERVERS.join(', ')}\`\n` +
                    `🔴移入名單 🟡移出名單`
            },
            {
                title: `🚨 移入總覽（共 ${incomingList.length} 筆）`,
                color: 15105570,
                description: incomingText
            },
            {
                title: `⚠️ 移出總覽（共 ${outgoingList.length} 筆）`,
                color: 15418782,
                description: outgoingText,
                footer: { text: "Transfer Radar 狀態看板 • 自動原地更新" },
                timestamp: new Date().toISOString()
            }
        ]
    };

    try {
        await axios.patch(`${DISCORD_WEBHOOK_URL}/messages/${DISCORD_MESSAGE_ID}`, dashboardPayload);
        console.log('✅ 戰情狀態看板已原地更新！');
    } catch (err) {
        console.error('❌ 更新狀態看板失敗:', err.response?.data || err.message);
    }

    // ========================================================
    // 動作 B：發送【單筆新移民警報】
    // ========================================================
    if (newAlerts.length > 0) {
        console.log(`🚨 發現 ${newAlerts.length} 筆新變動！準備發送單筆警報...`);
        for (const alert of newAlerts) {
            const isIncoming = alert.alertType === 'IN';
            const embedPayload = {
                username: "天堂M 移民警報",
                embeds: [
                    {
                        title: isIncoming 
                            ? `🚨 【移入警報】新玩家進入【${alert.targetServer}】`
                            : `⚠️ 【移出警報】有玩家離開【${alert.prevServer}】`,
                        color: isIncoming ? 15158332 : 3447003,
                        fields: [
                            { name: "玩家名稱", value: `**${alert.player}**`, inline: true },
                            { name: "職業", value: alert.job, inline: true },
                            { name: "動向路徑", value: `\`${alert.prevServer}\` ➔ \`${alert.targetServer}\``, inline: false },
                            { name: "原角色名稱", value: alert.prevName || "無變更", inline: true },
                            { name: "目標群組", value: alert.serverGroup, inline: true }
                        ],
                        footer: { text: "天堂M 單筆即時警報" },
                        timestamp: new Date().toISOString()
                    }
                ]
            };

            try {
                await axios.post(DISCORD_WEBHOOK_URL, embedPayload);
                console.log(`✉️ 已發送單筆警報 (${alert.alertType})：${alert.player}`);
                await new Promise(r => setTimeout(r, 1000));
            } catch (err) {
                console.error(`❌ 單筆警報發送失敗 (${alert.player}):`, err.message);
            }
        }
    } else {
        console.log('✅ 目前沒有符合條件的新移民或離開動態。');
    }

    // 5. 將最新的已通知清單寫回檔案
    if (notifiedHistory.length > 1500) {
        notifiedHistory = notifiedHistory.slice(-1500);
    }
    const dir = path.dirname(HISTORY_FILE);
    if (!fs.existsSync(dir)) {
        fs.mkdirSync(dir, { recursive: true });
    }
    fs.writeFileSync(HISTORY_FILE, JSON.stringify(notifiedHistory, null, 2));
}

run();
