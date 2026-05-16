import "dotenv/config";
import * as cheerio from "cheerio";
import axios from "axios";

const PUSHOVER_API_URL = "https://api.pushover.net/1/messages.json";
const STATION_URL = "https://wasserportal.berlin.de/station.php?anzeige=g&thema=owt&station=139";
const DOWNLOAD_URL = "https://wasserportal.berlin.de/station.php";

// Fetch current data (last ~8 days) from the HTML table
function parseTableDataPoints($) {
  const points = [];
  let tableFound = false;

  $("table").each((_, table) => {
    if (tableFound) return;
    const headerRow = $(table).find("tr").first();
    const headers = [];
    headerRow.find("th, td").each((_, th) => {
      headers.push($(th).text().trim());
    });
    if (!headers.includes("00:00")) return;
    tableFound = true;

    $(table).find("tr").slice(1).each((_, row) => {
      const cells = $(row).find("td");
      if (cells.length === 0) return;
      const dateStr = $(cells[0]).text().trim();
      if (!dateStr) return;
      const parts = dateStr.split(".");
      if (parts.length < 3) return;
      const day = parseInt(parts[0], 10);
      const month = parseInt(parts[1], 10);
      const year = parseInt(parts[2], 10);
      if (isNaN(day) || isNaN(month) || isNaN(year)) return;

      for (let i = 1; i < cells.length; i++) {
        const raw = $(cells[i]).text().trim().replace(/\s/g, "").replace(",", ".");
        const val = parseFloat(raw);
        if (!raw || raw === "-" || isNaN(val) || val < 0 || val > 35) continue;
        const timeStr = headers[i];
        if (!timeStr || !timeStr.includes(":")) continue;
        const [hour, minute] = timeStr.split(":").map(Number);
        points.push({ timestamp: new Date(year, month - 1, day, hour, minute), temp: val });
      }
    });
  });

  return points.sort((a, b) => a.timestamp - b.timestamp);
}

// Fetch historical daily values (Tageswerte) via POST for the past ~45 days
async function fetchHistoricalDailyValues() {
  const now = new Date();
  const from = new Date(now);
  from.setDate(from.getDate() - 45);
  const pad = (n) => String(n).padStart(2, "0");
  const sdatum = `${pad(from.getDate())}.${pad(from.getMonth() + 1)}.${from.getFullYear()}`;

  try {
    const response = await axios.post(
      DOWNLOAD_URL,
      new URLSearchParams({
        anzeige: "d",
        station: "139",
        thema: "owt",
        sreihe: "ew",
        smode: "c",
        sdatum,
      }).toString(),
      {
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        responseType: "text",
        maxRedirects: 5,
      }
    );

    const csv = response.data;
    if (!csv || csv.includes("<html") || csv.includes("Notice:")) {
      return null; // server returned an error page
    }
    return parseCSV(csv);
  } catch {
    return null;
  }
}

// Parse Einzelwerte CSV
// Format: "dd.mm.yyyy HH:MM";value
// We downsample to one value per day (noon-nearest) to keep the regression light
function parseCSV(csv) {
  const byDay = new Map(); // "yyyy-mm-dd" -> { timestamp, temp, distFromNoon }
  const lines = csv.split("\n");
  for (const line of lines) {
    const parts = line.trim().split(";").map((s) => s.replace(/^"|"$/g, "").trim());
    if (parts.length < 2) continue;
    // parts[0] = "01.04.2026 00:00"
    const dtParts = parts[0].split(" ");
    if (dtParts.length < 2) continue;
    const dateParts = dtParts[0].split(".");
    if (dateParts.length < 3) continue;
    const day = parseInt(dateParts[0], 10);
    const month = parseInt(dateParts[1], 10);
    const year = parseInt(dateParts[2], 10);
    const timeParts = dtParts[1].split(":");
    const hour = parseInt(timeParts[0], 10);
    const minute = parseInt(timeParts[1] || "0", 10);
    if ([day, month, year, hour, minute].some(isNaN)) continue;
    const val = parseFloat(parts[1].replace(",", "."));
    if (isNaN(val) || val <= -777 || val < 0 || val > 35) continue;
    const ts = new Date(year, month - 1, day, hour, minute);
    const key = `${year}-${month}-${day}`;
    const distFromNoon = Math.abs(hour * 60 + minute - 12 * 60);
    if (!byDay.has(key) || distFromNoon < byDay.get(key).distFromNoon) {
      byDay.set(key, { timestamp: ts, temp: val, distFromNoon });
    }
  }
  return [...byDay.values()]
    .map(({ timestamp, temp }) => ({ timestamp, temp }))
    .sort((a, b) => a.timestamp - b.timestamp);
}

// Linear regression – returns °C/day slope and a predict(date) function
function linearRegression(points) {
  const n = points.length;
  if (n < 3) return null;
  const MS_PER_DAY = 86400000;
  const t0 = points[0].timestamp.getTime();
  const xs = points.map((p) => (p.timestamp.getTime() - t0) / MS_PER_DAY);
  const ys = points.map((p) => p.temp);
  const meanX = xs.reduce((a, b) => a + b, 0) / n;
  const meanY = ys.reduce((a, b) => a + b, 0) / n;
  let num = 0, den = 0;
  for (let i = 0; i < n; i++) {
    num += (xs[i] - meanX) * (ys[i] - meanY);
    den += (xs[i] - meanX) ** 2;
  }
  if (den === 0) return null;
  const slope = num / den; // °C per day
  const intercept = meanY - slope * meanX;
  return {
    slope,
    predict: (date) => slope * ((date.getTime() - t0) / MS_PER_DAY) + intercept,
  };
}

async function fetchData() {
  // Always fetch current table data
  const tableResponse = await axios.get(STATION_URL);
  const $ = cheerio.load(tableResponse.data);
  const tablePoints = parseTableDataPoints($);
  if (tablePoints.length === 0) throw new Error("No data points found in table");

  const latest = tablePoints[tablePoints.length - 1];

  // 24h change
  const targetYesterday = latest.timestamp.getTime() - 24 * 60 * 60 * 1000;
  const yesterday = tablePoints.reduce((best, p) =>
    Math.abs(p.timestamp.getTime() - targetYesterday) <
    Math.abs(best.timestamp.getTime() - targetYesterday) ? p : best,
    tablePoints[0]
  );
  const change = latest.temp - yesterday.temp;

  // Try to get historical daily values for better regression
  const histPoints = await fetchHistoricalDailyValues();
  const regressionPoints = histPoints && histPoints.length >= 10 ? histPoints : tablePoints;
  const dataSource = histPoints && histPoints.length >= 10 ? `${histPoints.length} Tageswerte` : `${tablePoints.length} Einzelwerte (Fallback)`;

  const regression = linearRegression(regressionPoints);
  const june7 = new Date(latest.timestamp.getFullYear(), 5, 7, 9, 0);
  let forecast = regression ? regression.predict(june7) : null;

  // Sanity: Spree June temperature is 15–28°C range
  if (forecast !== null && (forecast < 10 || forecast > 30)) forecast = null;

  return { latest, change, forecast, june7, dataSource };
}

async function sendPushover(message) {
  const token = process.env.PUSHOVER_TOKEN;
  const user = process.env.PUSHOVER_USER;
  if (!token || !user) throw new Error("Missing PUSHOVER_TOKEN or PUSHOVER_USER");

  const response = await axios.post(
    PUSHOVER_API_URL,
    new URLSearchParams({ token, user, title: "🌊 Spree Wassertemperatur", message, sound: "none" }).toString(),
    { headers: { "Content-Type": "application/x-www-form-urlencoded" } }
  );
  if (response.data.status !== 1) throw new Error(`Pushover error: ${JSON.stringify(response.data)}`);
}

function formatDate(date) {
  return date.toLocaleDateString("de-DE", { day: "2-digit", month: "2-digit", year: "numeric" });
}

async function main() {
  console.log(`[${new Date().toISOString()}] Fetching water temperature...`);

  const { latest, change, forecast, june7, dataSource } = await fetchData();

  const latestDateStr = formatDate(latest.timestamp);
  const latestTimeStr = latest.timestamp.toLocaleTimeString("de-DE", { hour: "2-digit", minute: "2-digit" });
  const changeSign = change >= 0 ? "+" : "";
  const changeArrow = change > 0.3 ? "↑" : change < -0.3 ? "↓" : "→";

  let message =
    `MPS Fischerinsel (Spree)\n` +
    `Aktuell: ${latest.temp.toFixed(1)} °C (${latestDateStr} ${latestTimeStr})\n` +
    `Änderung (24h): ${changeArrow} ${changeSign}${change.toFixed(1)} °C\n`;

  if (forecast !== null) {
    message += `Trendprognose ${formatDate(june7)}: ~${forecast.toFixed(1)} °C`;
  } else {
    message += `Trendprognose 07.06.: nicht verfügbar`;
  }

  console.log(`Datenbasis: ${dataSource}`);
  console.log(`Message:\n${message}`);
  await sendPushover(message);
  console.log("Push notification sent successfully.");
}

main().catch((err) => {
  console.error("Error:", err.message);
  process.exit(1);
});
