const uuid = require('uuid');

const BOT_DEFAULT_DIAMETER = 80;
const BOT_DEFAULT_SPEED = 1;
const BOT_DEFAULT_MASS = 10;
const BOT_DEFAULT_CHANGE_DIRECTION_PROBABILITY = 0.01;

const BotManager = function (options) {
  this.worldWidth = options.worldWidth;
  this.worldHeight = options.worldHeight;
  if (options.botMoveSpeed == null) {
    this.botMoveSpeed = BOT_DEFAULT_SPEED;
  } else {
    this.botMoveSpeed = options.botMoveSpeed;
  }
  this.botMass = options.botMass || BOT_DEFAULT_MASS;
  this.botChangeDirectionProbability = options.botChangeDirectionProbability || BOT_DEFAULT_CHANGE_DIRECTION_PROBABILITY;
  this.botDefaultDiameter = options.botDefaultDiameter || BOT_DEFAULT_DIAMETER;

  this.botMoves = [
    {u: 1},
    {d: 1},
    {r: 1},
    {l: 1}
  ];
};

BotManager.prototype.generateRandomPosition = function (botRadius) {
  const botDiameter = botRadius * 2;
  return {
    x: Math.round(Math.random() * (this.worldWidth - botDiameter) + botRadius),
    y: Math.round(Math.random() * (this.worldHeight - botDiameter) + botRadius)
  };
};

BotManager.prototype.addBot = function (options) {
  if (!options) {
    options = {};
  }
  const diameter = options.diam || this.botDefaultDiameter;
  const radius = Math.round(diameter / 2);
  const botId = uuid.v4();

  const bot = {
    id: botId,
    type: 'player',
    subtype: 'bot',
    name: options.name || 'bot-' + Math.round(Math.random() * 10000),
    score: options.score || 0,
    speed: options.speed == null ? this.botMoveSpeed : options.speed,
    mass: options.mass || this.botMass,
    diam: diameter,
    changeDirProb: this.botChangeDirectionProbability,
    op: {}
  };
  if (options.x && options.y) {
    bot.x = options.x;
    bot.y = options.y;
  } else {
    const position = this.generateRandomPosition(radius);
    if (options.x) {
      bot.x = options.x;
    } else {
      bot.x = position.x;
    }
    if (options.y) {
      bot.y = options.y;
    } else {
      bot.y = position.y;
    }
  }

  return bot;
};

BotManager.prototype.removeBot = function (bot) {
  bot.delete = 1;
};

module.exports.BotManager = BotManager;
