const { createCanvas } = require("canvas");
const fs = require("node:fs");
const path = require("node:path");

const size = 256;
const canvas = createCanvas(size, size);
const ctx = canvas.getContext("2d");

ctx.fillStyle = "#0f1117";
ctx.beginPath();
ctx.roundRect(0, 0, size, size, 40);
ctx.fill();

ctx.fillStyle = "#e8784d";
ctx.font = "bold 160px monospace";
ctx.textAlign = "center";
ctx.textBaseline = "middle";
ctx.fillText("/", size / 2, size / 2);

const outputPath = path.join(__dirname, "icon.png");
fs.writeFileSync(outputPath, canvas.toBuffer("image/png"));
console.log("icon.png を作成しました");
