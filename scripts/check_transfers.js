const puppeteer = require('puppeteer');
const axios = require('axios');
const fs = require('fs');
const path = require('path');

// ================= 設定區 =================
const TARGET_URL = 'https://helper.lineagem.cc/id/'; // 目標網址

// 設定你要監控的「指定伺服器名單」（只要有玩家移入或移出這些伺服器，都會發送通知）
const WATCH_SERVERS = ['伊娃']; 

const DISCORD_WEBHOOK_URL = process.env.DISCORD_WEBHOOK_URL;
const HISTORY_FILE = path.join(__dirname, '../data/notified_history.json');
// ==========================================

async function run() {
    if (!DISCORD_WEBHOOK_URL) {
        console.error('❌ 錯誤：找不到 DISCORD_WEBHOOK_URL 環境變數');
        process.exit(1);
    }

    // 1. 讀取已通知過的歷史紀錄
    let notifiedHistory = [];
    if (fs.existsSync(HISTORY_FILE)) {
        notifiedHistory = JSON.parse(fs.readFileSync(HISTORY_FILE, 'utf8'));
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

    // 等待表格資料載入
    await new Promise(r => setTimeout(r, 3000));

    // 3. 解析表格內容 (職業、玩家、目標伺服器、伺服器群組、prev_name、prev_server)
    const transfers = await page.evaluate(() => {
        const rows = Array.from(document.querySelectorAll('table tbody tr'));
        return rows.map(row => {
            const cols = Array.from(row.querySelectorAll('td')).map(td => td.innerText.trim());
            if (cols.length < 6) return null;
            return {
                job: cols[0],           // 職業
                player: cols[1],        // 玩家名稱
                targetServer: cols[2],  // 目標伺服器
                serverGroup: cols[3],   // 伺服器群組
                prevName: cols[4],      // prev_name
                prevServer: cols[5]     // prev_server (原伺服器)
            };
        }).filter(item => item !== null && item.player !== '');
    });

    await browser.close();
    console.log(`📊 共抓取到 ${transfers.length} 筆移民資料。`);

    // 4. 過濾出符合「移入」或「移出」指定伺服器且尚未通知過的新資料
    const newAlerts = [];
    
    for (const item of transfers) {
        // 檢查 A：是否為「移入」我們關注的伺服器
        if (WATCH_SERVERS.includes(item.targetServer)) {
            const recordKey = `IN_${item.player}_${item.targetServer}_${item.prevServer}`;
            if (!notifiedHistory.includes(recordKey)) {
                newAlerts.push({ ...item, alertType: 'IN', recordKey });
                notifiedHistory.push(recordKey);
            }
        }

        // 檢查 B：是否為「移出/離開」我們關注的伺服器
        if (WATCH_SERVERS.includes(item.prevServer)) {
            const recordKey = `OUT_${item.player}_${item.targetServer}_${item.prevServer}`;
            if (!notifiedHistory.includes(recordKey)) {
                newAlerts.push({ ...item, alertType: 'OUT', recordKey });
                notifiedHistory.push(recordKey);
            }
        }
    }

    if (newAlerts.length === 0) {
        console.log('✅ 目前沒有符合條件的新移民或離開動態。');
        return;
    }

    console.log(`🚨 發現 ${newAlerts.length} 筆相關變動！準備發送 Discord 通知...`);

    // 5. 發送 Discord Embed 通知
    for (const alert of newAlerts) {
        const isIncoming = alert.alertType === 'IN';
        
        // 移入用紅色警戒，移出/離開用藍色提示，讓你一眼看出方向
        const embedColor = isIncoming ? 15158332 : 3447003; 
        const titleText = isIncoming 
            ? `🚨 【移入警報】有玩家搬家進入【${alert.targetServer}】`
            : `⚠️ 【移出警報】有玩家離開【${alert.prevServer}】`;

        const embedPayload = {
            username: "天堂M 移民雷達",
            embeds: [
                {
                    title: titleText,
                    color: embedColor,
                    fields: [
                        { name: "玩家名稱", value: `**${alert.player}**`, inline: true },
                        { name: "職業", value: alert.job, inline: true },
                        { name: "動向路徑", value: `\`${alert.prevServer}\` ➔ \`${alert.targetServer}\``, inline: false },
                        { name: "原角色名稱", value: alert.prevName || "無變更", inline: true },
                        { name: "目標群組", value: alert.serverGroup, inline: true }
                    ],
                    footer: { text: "天堂M 排行榜自動監控系統" },
                    timestamp: new Date().toISOString()
                }
            ]
        };

        try {
            await axios.post(DISCORD_WEBHOOK_URL, embedPayload);
            console.log(`✉️ 已發送 (${alert.alertType}) 通知：${alert.player} (${alert.prevServer} -> ${alert.targetServer})`);
            await new Promise(r => setTimeout(r, 1000)); // 避免觸發 Discord 頻率限制
        } catch (err) {
            console.error(`❌ 發送失敗 (${alert.player}):`, err.message);
        }
    }

    // 6. 將最新的已通知清單寫回檔案（自動確保 data 資料夾存在）
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
