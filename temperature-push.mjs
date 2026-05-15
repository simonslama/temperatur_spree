import "dotenv/config";
import * as cheerio from "cheerio";
import axios from "axios";

const PUSHOVER_API_URL = "https://api.pushover.net/1/messages.json";

const STATION_URL =
  "https://wasserportal.berlin.de/station.php?anzeige=g&thema=owt&station=139";

async function fetchTemperature() {
  const response = await axios.get(STATION_URL);
  const html = response.data;
  const $ = cheerio.load(html);

  // Find the temperature table and get the most recent non-empty value
  let latestTime = null;
  let latestTemp = null;
  let latestDate = null;

  $("table").each((_, table) => {
    const headerRow = $(table).find("tr").first();
    const headers = [];
    headerRow.find("th, td").each((_, th) => {
      headers.push($(th).text().trim());
    });

    // Check if this looks like the temperature table (has time columns)
    if (!headers.includes("00:00")) return;

    // Iterate rows (each row = one day)
    $(table)
      .find("tr")
      .slice(1)
      .each((_, row) => {
        const cells = $(row).find("td");
        if (cells.length === 0) return;

        const date = $(cells[0]).text().trim();
        if (!date) return;

        // Scan columns right-to-left to find the last non-empty value
        for (let i = cells.length - 1; i >= 1; i--) {
          const val = $(cells[i]).text().trim();
          if (val && val !== "-") {
            const timeHeader = headers[i];
            if (!latestDate) {
              latestDate = date;
              latestTime = timeHeader;
              latestTemp = val;
            }
            return; // stop after first hit in this row
          }
        }

        if (latestDate) return false; // stop after first row with data
      });
  });

  if (!latestTemp) {
    throw new Error("Could not find temperature value in page");
  }

  return { date: latestDate, time: latestTime, temp: latestTemp };
}

async function sendPushover(message) {
  const token = process.env.PUSHOVER_TOKEN;
  const user = process.env.PUSHOVER_USER;

  if (!token || !user) {
    throw new Error(
      "Missing PUSHOVER_TOKEN or PUSHOVER_USER environment variables"
    );
  }

  const response = await axios.post(
    PUSHOVER_API_URL,
    new URLSearchParams({ token, user, title: "🌊 Spree Wassertemperatur", message, sound: "none" }).toString(),
    { headers: { "Content-Type": "application/x-www-form-urlencoded" } }
  );

  if (response.data.status !== 1) {
    throw new Error(`Pushover error: ${JSON.stringify(response.data)}`);
  }
}

async function main() {
  console.log(`[${new Date().toISOString()}] Fetching water temperature...`);

  const { date, time, temp } = await fetchTemperature();
  const message = `MPS Fischerinsel (Spree): ${temp} °C\nLetzter Messwert: ${date} ${time} Uhr`;

  console.log(`Sending: ${message}`);
  await sendPushover(message);
  console.log("Push notification sent successfully.");
}

main().catch((err) => {
  console.error("Error:", err.message);
  process.exit(1);
});
