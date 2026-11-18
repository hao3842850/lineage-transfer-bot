const puppeteer = require('puppeteer');
const axios = require('axios');
const fs = require('fs');
const path = require('path');

// ================= 設定區 =================
const TARGET_URL = 'https://helper.lineagem.cc/id/';

// 設定你要監控的「指定伺服器名單」
const WATCH_SERVERS = ['伊娃']; 

const DISCORD_WEBHOOK_URL = process.env.DISCORD_WEBHOOK_URL;
const DISCORD_MESSAGE_ID = process.env.DISCORD_MESSAGE_ID; // 固定戰情看板的訊息 ID
const HISTORY_FILE = path.join(__dirname, '../data/notified_history.json');
// ==========================================

async function run() {
    if (!DISCORD_WEBHOOK_URL || !DISCORD_MESSAGE_ID) {
        console.error('❌ 錯誤：請確認已設定 DISCORD_WEBHOOK_URL 與 DISCORD_MESSAGE_ID');
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

    await new Promise(r => setTimeout(r, 3000));

    // 3. 解析表格資料
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
                prevName: cols[4],      // 原名稱
                prevServer: cols[5]     // 原伺服器
            };
        }).filter(item => item !== null && item.player !== '');
    });

    await browser.close();
    console.log(`📊 共抓取到 ${transfers.length} 筆移民資料。`);

    // 4. 篩選看板資料 & 過濾出「尚未通知過」的新警報
    const incomingList = transfers.filter(t => WATCH_SERVERS.includes(t.targetServer));
    const outgoingList = transfers.filter(t => WATCH_SERVERS.includes(t.prevServer));
    const newAlerts = [];

    for (const item of transfers) {
        // 檢查移入
        if (WATCH_SERVERS.includes(item.targetServer)) {
            const recordKey = `IN_${item.player}_${item.targetServer}_${item.prevServer}`;
            if (!notifiedHistory.includes(recordKey)) {
                newAlerts.push({ ...item, alertType: 'IN', recordKey });
                notifiedHistory.push(recordKey);
            }
        }
        // 檢查移出
        if (WATCH_SERVERS.includes(item.prevServer)) {
            const recordKey = `OUT_${item.player}_${item.targetServer}_${item.prevServer}`;
            if (!notifiedHistory.includes(recordKey)) {
                newAlerts.push({ ...item, alertType: 'OUT', recordKey });
                notifiedHistory.push(recordKey);
            }
        }
    }

    // ========================================================
    // 動作 A：原地更新【戰情狀態看板】(每次執行都會更新)
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
                color: 5763719, // 綠色總覽框
                description: 
                    `📡 雷達掃描狀態：最後更新 <t:${nowUnix}:R>\n` +
                    `📊 全服總移民數：**${transfers.length}** 筆 | 監控相關：**${incomingList.length + outgoingList.length}** 筆\n` +
                    `🔍 看板限定伺服器：\`${WATCH_SERVERS.join(', ')}\`\n` +
                    `🔴移入名單 🟡移出名單`
            },
            {
                title: `🚨 移入總覽（共 ${incomingList.length} 筆）`,
                color: 15105570, // 橘色
                description: incomingText
            },
            {
                title: `⚠️ 移出總覽（共 ${outgoingList.length} 筆）`,
                color: 15418782, // 洋紅色
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
    // 動作 B：發送【單筆新移民警報】(只有抓到新名單才發送)
    // ========================================================
    if (newAlerts.length === 0) {
        console.log('✅ 目前沒有符合條件的新移民或離開動態，無需發送單筆警報。');
        return;
    }

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
                    color: isIncoming ? 15158332 : 3447003, // 移入紅框、移出藍框
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
