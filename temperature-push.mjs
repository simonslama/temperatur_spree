import "dotenv/config";
import * as cheerio from "cheerio";
import axios from "axios";

const PUSHOVER_API_URL = "https://api.pushover.net/1/messages.json";
const STATION_URL =
  "https://wasserportal.berlin.de/station.php?anzeige=g&thema=owt&station=139";

// Parse all available data points from the measurement table
function parseAllDataPoints($) {
  const points = []; // { timestamp: Date, temp: number }

  $("table").each((_, table) => {
    const headerRow = $(table).find("tr").first();
    const headers = [];
    headerRow.find("th, td").each((_, th) => {
      headers.push($(th).text().trim());
    });

    if (!headers.includes("00:00")) return;

    $(table)
      .find("tr")
      .slice(1)
      .each((_, row) => {
        const cells = $(row).find("td");
        if (cells.length === 0) return;

        const dateStr = $(cells[0]).text().trim();
        if (!dateStr) return;

        const parts = dateStr.split(".");
        if (parts.length < 3) return;
        const [day, month, year] = parts.map(Number);

        for (let i = 1; i < cells.length; i++) {
          const raw = $(cells[i]).text().trim().replace(",", ".");
          const val = parseFloat(raw);
          if (!raw || raw === "-" || isNaN(val)) continue;

          const timeStr = headers[i];
          if (!timeStr || !timeStr.includes(":")) continue;
          const [hour, minute] = timeStr.split(":").map(Number);

          const ts = new Date(year, month - 1, day, hour, minute);
          points.push({ timestamp: ts, temp: val });
        }
      });
  });

  return points.sort((a, b) => a.timestamp - b.timestamp);
}

// Simple linear regression; returns a prediction function f(Date) -> number
function linearRegression(points) {
  const n = points.length;
  if (n < 2) return null;

  const xs = points.map((p) => p.timestamp.getTime());
  const ys = points.map((p) => p.temp);

  const meanX = xs.reduce((a, b) => a + b, 0) / n;
  const meanY = ys.reduce((a, b) => a + b, 0) / n;

  let num = 0, den = 0;
  for (let i = 0; i < n; i++) {
    num += (xs[i] - meanX) * (ys[i] - meanY);
    den += (xs[i] - meanX) ** 2;
  }

  const slope = num / den;
  const intercept = meanY - slope * meanX;

  return (date) => slope * date.getTime() + intercept;
}

async function fetchData() {
  const response = await axios.get(STATION_URL);
  const $ = cheerio.load(response.data);
  const points = parseAllDataPoints($);

  if (points.length === 0) throw new Error("No data points found in table");

  // Latest value
  const latest = points[points.length - 1];

  // Value from ~24h ago (closest point to latest minus 24h)
  const targetYesterday = latest.timestamp.getTime() - 24 * 60 * 60 * 1000;
  const yesterday = points.reduce((best, p) => {
    const diff = Math.abs(p.timestamp.getTime() - targetYesterday);
    return diff < Math.abs(best.timestamp.getTime() - targetYesterday) ? p : best;
  }, points[0]);

  const change = latest.temp - yesterday.temp;

  // Forecast for June 7 via linear regression
  const predict = linearRegression(points);
  const june7 = new Date(latest.timestamp.getFullYear(), 5, 7, 9, 0);
  const forecast = predict ? predict(june7) : null;

  return { latest, yesterday, change, forecast, june7 };
}

async function sendPushover(message) {
  const token = process.env.PUSHOVER_TOKEN;
  const user = process.env.PUSHOVER_USER;

  if (!token || !user) {
    throw new Error("Missing PUSHOVER_TOKEN or PUSHOVER_USER environment variables");
  }

  const response = await axios.post(
    PUSHOVER_API_URL,
    new URLSearchParams({
      token, user,
      title: "🌊 Spree Wassertemperatur",
      message,
      sound: "none",
    }).toString(),
    { headers: { "Content-Type": "application/x-www-form-urlencoded" } }
  );

  if (response.data.status !== 1) {
    throw new Error(`Pushover error: ${JSON.stringify(response.data)}`);
  }
}

function formatDate(date) {
  return date.toLocaleDateString("de-DE", {
    day: "2-digit", month: "2-digit", year: "numeric",
  });
}

async function main() {
  console.log(`[${new Date().toISOString()}] Fetching water temperature...`);

  const { latest, change, forecast, june7 } = await fetchData();

  const latestDateStr = formatDate(latest.timestamp);
  const latestTimeStr = latest.timestamp.toLocaleTimeString("de-DE", {
    hour: "2-digit", minute: "2-digit",
  });

  const sign = change >= 0 ? "+" : "";
  const trendArrow = change > 0.3 ? "↑" : change < -0.3 ? "↓" : "→";

  let message =
    `MPS Fischerinsel (Spree)\n` +
    `Aktuell: ${latest.temp.toFixed(1)} °C (${latestDateStr} ${latestTimeStr})\n` +
    `Änderung (24h): ${trendArrow} ${sign}${change.toFixed(1)} °C\n`;

  if (forecast !== null) {
    message += `Trendprognose ${formatDate(june7)}: ~${forecast.toFixed(1)} °C`;
  }

  console.log(`Message:\n${message}`);
  await sendPushover(message);
  console.log("Push notification sent successfully.");
}

main().catch((err) => {
  console.error("Error:", err.message);
  process.exit(1);
});
