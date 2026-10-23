// Duration and Title Parsing Utilities

export function parseDuration(durationStr) {
  if (!durationStr) return "N/A";

  const regex = /PT(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?/;
  const match = durationStr.match(regex);
  if (!match) return "N/A";

  const hours = match[1] ? parseInt(match[1]) : 0;
  const minutes = match[2] ? parseInt(match[2]) : 0;
  const seconds = match[3] ? parseInt(match[3]) : 0;

  if (hours > 0) {
    return minutes > 0 ? `${hours} hr ${minutes} min` : `${hours} hr`;
  }
  if (minutes > 0) {
    return `${minutes} min`;
  }
  if (seconds > 0) {
    return `${seconds} sec`;
  }
  return "0 min";
}

export function getDurationSeconds(durationStr) {
  if (!durationStr) return 0;
  const regex = /PT(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?/;
  const match = durationStr.match(regex);
  if (!match) return 0;

  const hours = match[1] ? parseInt(match[1]) : 0;
  const minutes = match[2] ? parseInt(match[2]) : 0;
  const seconds = match[3] ? parseInt(match[3]) : 0;

  return (hours * 3600) + (minutes * 60) + seconds;
}

export function parseSpeakerAndTitle(rawTitle, channelName = "") {
  if (!rawTitle) return { speaker: channelName || "Featured Speaker", title: "" };

  // Decode standard HTML entities
  let clean = rawTitle
    .replace(/&amp;/g, '&')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>');

  // Strip trailing channel tags like " | TED", " | Big Think", " | Talks at Google"
  clean = clean
    .replace(/\s*\|\s*TEDx?(Talks)?\s*$/i, '')
    .replace(/\s*\|\s*Big Think\s*$/i, '')
    .replace(/\s*\|\s*Talks at Google\s*$/i, '')
    .replace(/\s*\|\s*Stanford\s*$/i, '')
    .replace(/\s*\|\s*Y Combinator\s*$/i, '')
    .replace(/\s*\|\s*HBR\s*$/i, '')
    .trim();

  // Pattern 1: "Speaker Name: Title of Talk" (common in TED, Google Talks)
  const colonIndex = clean.indexOf(':');
  if (colonIndex > 2 && colonIndex < 35) {
    const speaker = clean.substring(0, colonIndex).trim();
    const title = clean.substring(colonIndex + 1).trim();
    if (!speaker.toLowerCase().includes("how to") && !speaker.toLowerCase().includes("why")) {
      return { speaker, title };
    }
  }

  // Pattern 2: "Title of Talk | Speaker Name" or "Title - Speaker Name"
  const splitters = [' | ', ' - '];
  for (const splitter of splitters) {
    const parts = clean.split(splitter);
    if (parts.length === 2) {
      // Typically: part[0] is Title, part[1] is Speaker OR vice versa
      const part0 = parts[0].trim();
      const part1 = parts[1].trim();

      // If part1 is short (likely person's name < 30 chars), treat part1 as speaker
      if (part1.length > 2 && part1.length < 32 && !part1.toLowerCase().includes("part")) {
        return { speaker: part1, title: part0 };
      }
      // If part0 is short, treat part0 as speaker
      if (part0.length > 2 && part0.length < 32 && !part0.toLowerCase().includes("part")) {
        return { speaker: part0, title: part1 };
      }
    }
  }

  // Fallback
  return { speaker: channelName || "Featured Speaker", title: clean };
}
