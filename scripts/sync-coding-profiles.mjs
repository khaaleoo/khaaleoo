#!/usr/bin/env node
// Fetches CodinGame + HackerRank public stats and syncs them into README.md /
// assets/hackerrank-card.svg. Run daily via .github/workflows/sync-coding-profiles.yml.
//
// Both platforms have no official public API; this uses the same unofficial
// JSON endpoints their own front-ends call. If either endpoint shape changes,
// this script will start failing loudly (see error handling below) rather
// than silently writing bad data.

import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT_DIR = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const README_PATH = path.join(ROOT_DIR, "README.md");
const HACKERRANK_CARD_PATH = path.join(ROOT_DIR, "assets", "hackerrank-card.svg");

const CODINGAME_HANDLE = "1d7e8bf46674460ac34284a01afae5539876004";
const CODINGAME_PROFILE_URL = `https://www.codingame.com/profile/${CODINGAME_HANDLE}`;

const HACKERRANK_USERNAME = "khaaleoo";
const HACKERRANK_PROFILE_URL = `https://www.hackerrank.com/profile/${HACKERRANK_USERNAME}`;

const USER_AGENT = "Mozilla/5.0 (compatible; readme-profile-sync/1.0)";

// Formats a percentile with just enough precision to stay meaningful at very
// small values (e.g. top-100-of-a-million ranks round to "0%" at 0 decimals),
// trimming trailing zeros so "0.010" reads as "0.01".
function formatPercentile(rank, total) {
  const percent = (rank / total) * 100;
  if (percent < 0.01) return String(parseFloat(percent.toFixed(3)));
  if (percent < 1) return String(parseFloat(percent.toFixed(2)));
  if (percent < 10) return String(parseFloat(percent.toFixed(1)));
  return String(Math.ceil(percent));
}

function replaceBetweenMarkers(content, marker, newBlock) {
  const startTag = `<!-- ${marker}:START -->`;
  const endTag = `<!-- ${marker}:END -->`;
  const startIdx = content.indexOf(startTag);
  const endIdx = content.indexOf(endTag);
  if (startIdx === -1 || endIdx === -1) {
    throw new Error(`Could not find ${marker} markers in README.md`);
  }
  const before = content.slice(0, startIdx + startTag.length);
  const after = content.slice(endIdx);
  return `${before}\n  ${newBlock}\n  ${after}`;
}

function escapeXml(value) {
  return String(value)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}

// Shields.io static badges treat "-" as a field separator and spaces must be
// underscores, so percent-encode first and then swap literal spaces back in.
function shieldBadgeMessage(text) {
  return encodeURIComponent(text).replace(/%20/g, "_");
}

async function fetchCodinGameStats() {
  // Step 1: resolve the numeric codingamerId behind the public handle (also
  // gives us Level, which isn't tied to any specific ranking mode).
  const profileRes = await fetch(
    "https://www.codingame.com/services/CodinGamerRemoteService/findCodingamePointsStatsByHandle",
    {
      method: "POST",
      headers: { "Content-Type": "application/json", "User-Agent": USER_AGENT },
      body: JSON.stringify([CODINGAME_HANDLE]),
    },
  );
  if (!profileRes.ok) {
    throw new Error(`CodinGame profile API request failed: HTTP ${profileRes.status}`);
  }
  const profileData = await profileRes.json();
  // The endpoint sometimes wraps the payload in a "success" key and
  // sometimes returns it unwrapped, depending on caller headers.
  const profilePayload = profileData.success ?? profileData;
  const codingamerId = profilePayload?.codingamer?.userId;
  const level = profilePayload?.codingamer?.level;
  if (!codingamerId) {
    throw new Error("CodinGame profile API response missing codingamerId");
  }

  // Step 2: Clash of Code-specific rank, both global and within-country.
  // This is a different ranking pool than the "general leaderboard" rank
  // (and its Guru/Master/.../Rookie league titles), so we don't reuse those
  // titles here.
  const rankRes = await fetch("https://www.codingame.com/services/CodinGamer/FindRankingPoints", {
    method: "POST",
    headers: { "Content-Type": "application/json", "User-Agent": USER_AGENT },
    body: JSON.stringify([codingamerId]),
  });
  if (!rankRes.ok) {
    throw new Error(`CodinGame ranking API request failed: HTTP ${rankRes.status}`);
  }
  const rankData = await rankRes.json();
  const rankPayload = rankData.success ?? rankData;

  const rank = rankPayload?.clashPointsRankGlobal;
  const totalGlobal = rankPayload?.totalCodingamerGlobal?.clash;
  const countryRank = rankPayload?.clashPointsRankCountry;
  const totalCountry = rankPayload?.totalCodingamerCountry?.clash;
  const countryId = rankPayload?.countryId;
  if (!rank || !totalGlobal) {
    throw new Error("CodinGame ranking API response missing expected fields");
  }

  return {
    level,
    rank,
    percentile: formatPercentile(rank, totalGlobal),
    countryRank,
    countryId,
    hasCountryRank: Boolean(countryRank && totalCountry),
  };
}

async function updateCodinGameBadge(readmeContent, stats) {
  const parts = [`Clash #${stats.rank}`, `Top ${stats.percentile}%`];
  if (stats.hasCountryRank) parts.push(`${stats.countryId} #${stats.countryRank}`);
  const message = shieldBadgeMessage(parts.join(" | "));
  const badge =
    `<a href="${CODINGAME_PROFILE_URL}"><img src="https://img.shields.io/badge/CodinGame-${message}` +
    `-F2BB13?style=flat-square&logo=codingame&logoColor=white" alt="CodinGame Clash of Code Rank"/></a>`;
  console.log(`CodinGame: Clash rank #${stats.rank} -> top ${stats.percentile}%${stats.hasCountryRank ? `, ${stats.countryId} #${stats.countryRank}` : ""}`);
  return replaceBetweenMarkers(readmeContent, "CODINGAME", badge);
}

async function fetchHackerRankData() {
  const [profileRes, badgesRes, certsRes] = await Promise.all([
    fetch(`https://www.hackerrank.com/rest/contests/master/hackers/${HACKERRANK_USERNAME}/profile`, {
      headers: { "User-Agent": USER_AGENT },
    }),
    fetch(`https://www.hackerrank.com/rest/hackers/${HACKERRANK_USERNAME}/badges`, {
      headers: { "User-Agent": USER_AGENT },
    }),
    fetch(
      `https://www.hackerrank.com/community/v1/test_results/hacker_certificate?username=${HACKERRANK_USERNAME}`,
      { headers: { "User-Agent": USER_AGENT } },
    ),
  ]);

  if (!profileRes.ok) {
    throw new Error(`HackerRank profile request failed: HTTP ${profileRes.status}`);
  }
  const profile = (await profileRes.json()).model;
  const badges = badgesRes.ok ? (await badgesRes.json()).models ?? [] : [];
  const certsRaw = certsRes.ok ? (await certsRes.json()).data ?? [] : [];

  const certificates = certsRaw
    .filter((entry) => entry.attributes?.status === "test_passed")
    .map((entry) => {
      const rawName =
        entry.attributes.certificates?.[0] ??
        [entry.attributes.certificate?.label, entry.attributes.certificate?.level]
          .filter(Boolean)
          .join(" ") ??
        "Certificate";
      return {
        // Certificates with no level come back as "Name ()" from HackerRank's API.
        name: rawName.replace(/\s*\(\)\s*$/, ""),
        url: entry.attributes.certificate_image ?? HACKERRANK_PROFILE_URL,
      };
    });

  return { profile, badges, certificates };
}

function generateHackerRankSvg({ profile, badges, certificates }) {
  const level = profile?.level ?? "?";
  const width = 480;

  const rows = [];
  for (let i = 0; i < certificates.length; i += 2) {
    rows.push(certificates.slice(i, i + 2));
  }
  const rowHeight = 22;
  const listTop = 110;
  const height = certificates.length > 0 ? listTop + rows.length * rowHeight + 10 : listTop + 10;

  const certEntries = rows
    .map((row, rowIdx) =>
      row
        .map((cert, colIdx) => {
          const x = colIdx * 230;
          const y = rowIdx * rowHeight;
          const label = escapeXml(cert.name);
          const href = escapeXml(cert.url);
          return `
      <a xlink:href="${href}" target="_blank">
        <g transform="translate(${x}, ${y})">
          <circle cx="4" cy="-4" r="3" fill="#00EA64"/>
          <text x="12" y="0" font-family="Segoe UI, sans-serif" font-size="11" fill="#58a6ff">${label}</text>
        </g>
      </a>`;
        })
        .join(""),
    )
    .join("");

  return `<svg width="${width}" height="${height}" viewBox="0 0 ${width} ${height}" xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink">
  <rect width="${width}" height="${height}" rx="10" fill="#0d1117" stroke="#30363d" stroke-width="1"/>
  <text x="20" y="30" font-family="Segoe UI, sans-serif" font-size="16" font-weight="700" fill="#ffffff">HackerRank &#183; ${escapeXml(HACKERRANK_USERNAME)}</text>
  <text x="20" y="52" font-family="Segoe UI, sans-serif" font-size="12" fill="#8b949e">Level ${level} &#183; ${badges.length} badges &#183; ${certificates.length} certifications</text>
  <text x="20" y="85" font-family="Segoe UI, sans-serif" font-size="11" font-weight="600" fill="#8b949e">CERTIFICATIONS</text>
  <g transform="translate(20, ${listTop})">${certEntries}
  </g>
</svg>
`;
}

async function updateHackerRankCard() {
  const data = await fetchHackerRankData();
  const svg = generateHackerRankSvg(data);
  await mkdir(path.dirname(HACKERRANK_CARD_PATH), { recursive: true });
  await writeFile(HACKERRANK_CARD_PATH, svg, "utf8");
  const level = data.profile?.level ?? "?";
  console.log(`HackerRank: level ${level}, ${data.badges.length} badges, ${data.certificates.length} certifications`);
  return { level, badges: data.badges.length, certifications: data.certificates.length };
}

// Exposes results as GitHub Actions step outputs so later workflow steps
// (e.g. a Telegram notification) can reference them. No-op outside CI.
async function writeStepOutputs(values) {
  const outputFile = process.env.GITHUB_OUTPUT;
  if (!outputFile) return;
  const lines = Object.entries(values)
    .map(([key, value]) => `${key}=${value}`)
    .join("\n");
  await writeFile(outputFile, `${lines}\n`, { flag: "a" });
}

async function main() {
  const readme = await readFile(README_PATH, "utf8");
  const codinGameStats = await fetchCodinGameStats();
  const updatedReadme = await updateCodinGameBadge(readme, codinGameStats);
  await writeFile(README_PATH, updatedReadme, "utf8");
  const hackerRankStats = await updateHackerRankCard();

  await writeStepOutputs({
    codingame_rank: codinGameStats.rank,
    codingame_percent: codinGameStats.percentile,
    codingame_country: codinGameStats.hasCountryRank
      ? `${codinGameStats.countryId} #${codinGameStats.countryRank}`
      : "n/a",
    hackerrank_level: hackerRankStats.level,
    hackerrank_badges: hackerRankStats.badges,
    hackerrank_certifications: hackerRankStats.certifications,
  });
}

main().catch((err) => {
  console.error("Sync failed:", err);
  process.exitCode = 1;
});
