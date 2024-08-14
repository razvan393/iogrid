const uuid = require('uuid');
const SAT = require('sat');

const MAX_TRIALS = 10;

const COIN_DEFAULT_RADIUS = 10;
const COIN_DEFAULT_VALUE = 1;

const CoinManager = function (options) {
  this.cellData = options.cellData;

  const cellBounds = options.cellBounds;
  this.cellBounds = cellBounds;
  this.cellX = cellBounds.minX;
  this.cellY = cellBounds.minY;
  this.cellWidth = cellBounds.maxX - cellBounds.minX;
  this.cellHeight = cellBounds.maxY - cellBounds.minY;

  this.playerNoDropRadius = options.playerNoDropRadius;
  this.coinMaxCount = options.coinMaxCount;
  this.coinDropInterval = options.coinDropInterval;

  this.coins = {};
  this.coinCount = 0;
};

CoinManager.prototype.generateRandomAvailablePosition = function (coinRadius) {
  const coinDiameter = coinRadius * 2;
  const circles = [];

  const players = this.cellData.player;

  for (let i in players) {
    const curPlayer = players[i];
    circles.push(new SAT.Circle(new SAT.Vector(curPlayer.x, curPlayer.y), this.playerNoDropRadius));
  }

  let position = null;

  for (let j = 0; j < MAX_TRIALS; j++) {
    const tempPosition = {
      x: this.cellX + Math.round(Math.random() * (this.cellWidth - coinDiameter) + coinRadius),
      y: this.cellY + Math.round(Math.random() * (this.cellHeight - coinDiameter) + coinRadius)
    };

    const tempPoint = new SAT.Vector(tempPosition.x, tempPosition.y);

    let validPosition = true;
    for (let k = 0; k < circles.length; k++) {
      if (SAT.pointInCircle(tempPoint, circles[k])) {
        validPosition = false;
        break;
      }
    }
    if (validPosition) {
      position = tempPosition;
      break;
    }
  }
  return position;
};

CoinManager.prototype.addCoin = function (value, subtype, radius) {
  radius = radius || COIN_DEFAULT_RADIUS;
  const coinId = uuid.v4();
  const validPosition = this.generateRandomAvailablePosition(radius);
  if (validPosition) {
    const coin = {
      id: coinId,
      type: 'coin',
      t: subtype || 1,
      v: value || COIN_DEFAULT_VALUE,
      r: radius,
      x: validPosition.x,
      y: validPosition.y
    };
    this.coins[coinId] = coin;
    this.coinCount++;
    return coin;
  }
  return null;
};

CoinManager.prototype.removeCoin = function (coinId) {
  const coin = this.coins[coinId];
  if (coin) {
    coin.delete = 1;
    delete this.coins[coinId];
    this.coinCount--;
  }
};

CoinManager.prototype.doesPlayerTouchCoin = function (coinId, player) {
  const coin = this.coins[coinId];
  if (!coin) {
    return false;
  }
  const playerCircle = new SAT.Circle(new SAT.Vector(player.x, player.y), Math.ceil(player.width / 2));
  const coinCircle = new SAT.Circle(new SAT.Vector(coin.x, coin.y), coin.r);
  return SAT.testCircleCircle(playerCircle, coinCircle);
};

module.exports.CoinManager = CoinManager;
