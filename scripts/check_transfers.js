const puppeteer = require('puppeteer');
const axios = require('axios');

// ================= 設定區 =================
const TARGET_URL = 'https://helper.lineagem.cc/id/';
const WATCH_SERVERS = ['伊娃']; // 你要監控的伺服器

const DISCORD_WEBHOOK_URL = process.env.DISCORD_WEBHOOK_URL;
const DISCORD_MESSAGE_ID = process.env.DISCORD_MESSAGE_ID; // 要原地更新的訊息 ID
// ==========================================

async function run() {
    if (!DISCORD_WEBHOOK_URL || !DISCORD_MESSAGE_ID) {
        console.error('❌ 錯誤：請確認已設定 DISCORD_WEBHOOK_URL 與 DISCORD_MESSAGE_ID');
        process.exit(1);
    }

    console.log('🚀 啟動瀏覽器抓取最新移民名單...');
    const browser = await puppeteer.launch({
        headless: 'new',
        args: ['--no-sandbox', '--disable-setuid-sandbox']
    });
    const page = await browser.newPage();
    await page.goto(TARGET_URL, { waitUntil: 'networkidle2', timeout: 60000 });

    // 點擊「本週移民」
    await page.evaluate(() => {
        const elements = Array.from(document.querySelectorAll('a, button, div, span'));
        const transferBtn = elements.find(el => el.textContent.trim() === '本週移民');
        if (transferBtn) transferBtn.click();
    });

    await new Promise(r => setTimeout(r, 3000));

    // 解析表格資料
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

    // 分類：移入名單 vs 移出名單
    const incomingList = transfers.filter(t => WATCH_SERVERS.includes(t.targetServer));
    const outgoingList = transfers.filter(t => WATCH_SERVERS.includes(t.prevServer));

    // 取得目前的 Unix 時間戳（讓 Discord 自動顯示「幾分鐘前」的灰底動態標籤）
    const nowUnix = Math.floor(Date.now() / 1000);

    // 組合「移入明細」文字（最多顯示最近 15 筆避免超過 Discord 字數上限）
    const incomingText = incomingList.length > 0
        ? incomingList.slice(0, 15).map(item => 
            `🔴 **${item.player}** (${item.job}) ➔ 進入【${item.targetServer}】 *(原: ${item.prevServer} / ${item.prevName})*`
          ).join('\n')
        : '目前監控伺服器無新增移入紀錄';

    // 組合「移出明細」文字
    const outgoingText = outgoingList.length > 0
        ? outgoingList.slice(0, 15).map(item => 
            `🟡 **${item.player}** (${item.job}) ➔ 離開【${item.prevServer}】前往【${item.targetServer}】`
          ).join('\n')
        : '目前監控伺服器無人員移出紀錄';

    // 組合 3 張戰情看板 Embeds（仿照截圖排版）
    const dashboardPayload = {
        username: "SkyNet 移民雷達",
        embeds: [
            // 卡片 1：綠色總覽看板
            {
                title: "📡 本週移民監控看板",
                color: 5763719, // 綠色邊框
                description: 
                    `📡 雷達掃描狀態：最後更新 <t:${nowUnix}:R>\n` +
                    `📊 全服總移民數：**${transfers.length}** 筆 | 監控相關：**${incomingList.length + outgoingList.length}** 筆\n` +
                    `🔍 看板限定伺服器：\`${WATCH_SERVERS.join(', ')}\`\n` +
                    `🔴移入警戒 🟡移出動態 ⚪歷史存檔`
            },
            // 卡片 2：橘色移入警戒區塊
            {
                title: `🚨 移入警戒（共 ${incomingList.length} 筆）`,
                color: 15105570, // 橘色邊框
                description: incomingText
            },
            // 卡片 3：洋紅色移出動態區塊
            {
                title: `⚠️ 移出動態（共 ${outgoingList.length} 筆）`,
                color: 15418782, // 洋紅色邊框
                description: outgoingText,
                footer: { text: "Transfer Radar 監控系統 • 自動原地更新" },
                timestamp: new Date().toISOString()
            }
        ]
    };

    // 使用 PATCH 方法直接修改同一則訊息（原地更新看板）
    const editUrl = `${DISCORD_WEBHOOK_URL}/messages/${DISCORD_MESSAGE_ID}`;
    
    try {
        await axios.patch(editUrl, dashboardPayload);
        console.log('✅ 戰情看板已成功原地更新！');
    } catch (err) {
        console.error('❌ 更新看板失敗:', err.response?.data || err.message);
    }
}

run();
