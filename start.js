const { spawn } = require("child_process");

const server = spawn("node", ["server.js"], { stdio: "inherit" });
const bot = spawn("node", ["bot.js"], { stdio: "inherit" });

server.on("exit", function(code) {
  console.log("server.js saiu com codigo " + code);
});

bot.on("exit", function(code) {
  console.log("bot.js saiu com codigo " + code);
});
