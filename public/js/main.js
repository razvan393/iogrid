var socket = socketCluster.connect({
    codecEngine: scCodecMinBin
});

window.onload = function () {

    //  Note that this html file is set to pull down Phaser from our public/ directory.
    //  Although it will work fine with this tutorial, it's almost certainly not the most current version.
    //  Be sure to replace it with an updated version before you start experimenting with adding your own code.

    var game, playerId, player, bulletTime = 0, bullets;
    var users = {};
    var coins = {};

    var WORLD_WIDTH;
    var WORLD_HEIGHT;
    var WORLD_COLS;
    var WORLD_ROWS;
    var WORLD_CELL_WIDTH;
    var WORLD_CELL_HEIGHT;
    var PLAYER_LINE_OF_SIGHT = Math.round(window.innerWidth);
    var PLAYER_INACTIVITY_TIMEOUT = 700;
    var USER_INPUT_INTERVAL = 20;
    var COIN_INACTIVITY_TIMEOUT = 2200;
    var ENVIRONMENT;
    var SERVER_WORKER_ID;

    var youTextures = {
        up: 'img/you-back.png',
        left: 'img/you-side-left.png',
        right: 'img/you-side-right.png',
        down: 'img/you-front.png'
    };

    var othersTextures = {
        up: 'img/others-back.png',
        left: 'img/others-side-left.png',
        right: 'img/others-side-right.png',
        down: 'img/others-front.png'
    };

    var botTextures = {
        up: 'img/bot-back.png',
        left: 'img/bot-side-left.png',
        right: 'img/bot-side-right.png',
        down: 'img/bot-front.png'
    };

    // Map the score value to the texture.
    var cristalTextures = {
        1: 'img/cristal-1.png',
        2: 'img/cristal-2.png',
        3: 'img/cristal-3.png',
        4: 'img/cristal-4.png'
    };

    var bulletImages = {
        1: 'img/bullet.png'
    };

    var obstacles = {
        1: 'img/obstacle.png'
    };

    // 1 means no smoothing. 0.1 is quite smooth.
    var CAMERA_SMOOTHING = 1;
    var BACKGROUND_TEXTURE = 'img/background-texture.png';

    socket.emit('getWorldInfo', null, function (err, data) {
        WORLD_WIDTH = data.width;
        WORLD_HEIGHT = data.height;
        WORLD_COLS = data.cols;
        WORLD_ROWS = data.rows;
        WORLD_CELL_WIDTH = data.cellWidth;
        WORLD_CELL_HEIGHT = data.cellHeight;
        WORLD_CELL_OVERLAP_DISTANCE = data.cellOverlapDistance;
        SERVER_WORKER_ID = data.serverWorkerId;
        ENVIRONMENT = data.environment;

        channelGrid = new ChannelGrid({
            worldWidth: WORLD_WIDTH,
            worldHeight: WORLD_HEIGHT,
            rows: WORLD_ROWS,
            cols: WORLD_COLS,
            cellOverlapDistance: WORLD_CELL_OVERLAP_DISTANCE,
            exchange: socket
        });

        game = new Phaser.Game('100', '100', Phaser.AUTO, '', {
            preload: preload,
            create: create,
            render: render,
            update: update
        });
    });

    document.addEventListener('keydown', function(event) {
        var evt = event || window.event;
        if (evt.keyCode == 27) {
            document.location = '/index.html';
        }
        });

    function preload() {
        keys = {
            up: game.input.keyboard.addKey(Phaser.Keyboard.UP),
            down: game.input.keyboard.addKey(Phaser.Keyboard.DOWN),
            right: game.input.keyboard.addKey(Phaser.Keyboard.RIGHT),
            left: game.input.keyboard.addKey(Phaser.Keyboard.LEFT),
            shoot: game.input.keyboard.addKey(Phaser.Keyboard.SPACEBAR)
        };

        game.load.image('background', BACKGROUND_TEXTURE);

        game.load.image('you-up', youTextures.up);
        game.load.image('you-down', youTextures.down);
        game.load.image('you-right', youTextures.right);
        game.load.image('you-left', youTextures.left);

        game.load.image('others-up', othersTextures.up);
        game.load.image('others-down', othersTextures.down);
        game.load.image('others-right', othersTextures.right);
        game.load.image('others-left', othersTextures.left);

        game.load.image('bot-up', botTextures.up);
        game.load.image('bot-down', botTextures.down);
        game.load.image('bot-right', botTextures.right);
        game.load.image('bot-left', botTextures.left);

        game.load.image('cristal-1', cristalTextures[1]);
        game.load.image('cristal-2', cristalTextures[2]);
        game.load.image('cristal-3', cristalTextures[3]);
        game.load.image('cristal-4', cristalTextures[4]);

        game.load.image('bullet', bulletImages[1]);

        game.load.image('obstacle', obstacles[1]);
    }

    function handleCellData(stateList) {
        stateList.forEach(function (state) {
            if (state.type == 'player') {
                updateUser(state);
                if (state.subtype != 'bot' && state.remove) {
                    var user = users[state.id];
                    var overlay = document.querySelectorAll('[data-attr="'+ user.name +'"]')[0];
                    var popup = document.getElementById("score-pop");
                    if (state.remove) {
                        overlay.style.display = 'block';
                        popup.style.display = 'block';
                        popup.firstElementChild.textContent = 'You scored ' + user.score + ' points';
                    }
                    removeUser(user);
                }
            } else if (state.type == 'coin') {
                if (state.delete) {
                    removeCoin(state);
                } else {
                    renderCoin(state);
                }
            }
        });
        updatePlayerZIndexes();
    }

    var watchingCells = {};

    /*
     Data channels within our game are divided a grids and we only watch the cells
     which are within our player's line of sight.
     As the player moves around the game world, we need to keep updating the cell subscriptions.
     */
    function updateCellWatchers(playerData, channelName, handler) {
        var options = {
            lineOfSight: PLAYER_LINE_OF_SIGHT
        };
        channelGrid.updateCellWatchers(playerData, channelName, options, handler);
    }

    function updateUserGraphics(user) {
        user.sprite.x = user.x;
        user.sprite.y = user.y;

        if (!user.direction) {
            user.direction = 'down';
        }
        user.sprite.loadTexture(user.texturePrefix + '-' + user.direction);

        user.label.alignTo(user.sprite, Phaser.BOTTOM_CENTER, 0, 10);
    }

    function moveUser(userId, x, y) {
        var user = users[userId];
        user.x = x;
        user.y = y;
        updateUserGraphics(user);
        user.clientProcessed = Date.now();

        if (user.id == playerId) {
            updateCellWatchers(user, 'cell-data', handleCellData);
        }
    }

    function removeUser(userData) {
        var user = users[userData.id];
        if (user) {
            user.sprite.destroy();
            user.label.destroy();
            delete users[userData.id];
        }
    }

    function createTexturedSprite(options) {
        var sprite = game.add.sprite(0, 0, options.texture);
        sprite.anchor.setTo(0.5);

        return sprite;
    }

    function createUserSprite(userData) {
        var user = {};
        users[userData.id] = user;
        user.id = userData.id;
        user.swid = userData.swid;
        user.name = userData.name;

        var textStyle = {
            font: '16px Arial',
            fill: '#666666',
            align: 'center'
        };

        user.label = game.add.text(0, 0, user.name, textStyle);
        user.label.anchor.set(0.5);

        var sprite;

        if (userData.id == playerId) {
            sprite = createTexturedSprite({
                texture: 'you-down'
            });
            user.texturePrefix = 'you';
        } else if (userData.subtype == 'bot') {
            sprite = createTexturedSprite({
                texture: 'bot-down'
            });
            user.texturePrefix = 'bot';
        } else {
            sprite = createTexturedSprite({
                texture: 'others-down'
            });
            user.texturePrefix = 'others';
        }

        user.score = userData.score;
        user.sprite = sprite;

        var overlay = document.getElementById('overlay');
        var checkPlayer = user.name.indexOf('bot');
        if (checkPlayer == -1) {
            overlay.setAttribute('data-attr', user.name);
        }

        //todo
        /*user.sprite.width = Math.round(userData.diam * 0.93);
        user.sprite.height = userData.diam;
        user.diam = user.sprite.width;*/

        moveUser(userData.id, userData.x, userData.y);

        if (userData.id == playerId) {
            player = user;
            game.camera.setSize(window.innerWidth, window.innerHeight);
            game.camera.follow(user.sprite, null, CAMERA_SMOOTHING, CAMERA_SMOOTHING);
        }
    }

    function updatePlayerZIndexes() {
        var usersArray = [];
        for (var i in users) {
            if (users.hasOwnProperty(i)) {
                usersArray.push(users[i]);
            }
        }
        usersArray.sort(function (a, b) {
            if (a.y < b.y) {
                return -1;
            }
            if (a.y > b.y) {
                return 1;
            }
            return 0;
        });
        usersArray.forEach(function (user) {
            user.label.bringToTop();
            user.sprite.bringToTop();
        });
    }

    function updateUser(userData) {
        var user = users[userData.id];
        if (user) {
            user.score = userData.score;
            user.direction = userData.direction;
            moveUser(userData.id, userData.x, userData.y);
        } else {
            createUserSprite(userData);
        }
    }

    function removeCoin(coinData) {
        var coinToRemove = coins[coinData.id];
        if (coinToRemove) {
            coinToRemove.sprite.destroy();
            delete coins[coinToRemove.id];
        }
    }

    function renderCoin(coinData) {
        if (coins[coinData.id]) {
            coins[coinData.id].clientProcessed = Date.now();
        } else {
            var coin = coinData;
            coins[coinData.id] = coin;
            coin.sprite = createTexturedSprite({
                texture: 'cristal-' + (coinData.t || '1')
            });
            coin.sprite.x = coinData.x;
            coin.sprite.y = coinData.y;
            coin.clientProcessed = Date.now();
        }
    }

    function fireBullet() {
        if(game.time.now > bulletTime) {
            var bullet = bullets.getFirstExists(false);

            if(bullet) {
                if (player.direction == 'up') {
                    bullet.reset(player.x, player.y);
                    bullet.body.velocity.y = -1200;
                }
                if (player.direction == 'down') {
                    bullet.reset(player.x, player.y + 100);
                    bullet.body.velocity.y = 1200;
                }
                if (player.direction == 'left') {
                    bullet.reset(player.x, player.y);
                    bullet.body.velocity.x = -1200;
                }
                if (player.direction == 'right') {
                    bullet.reset(player.x, player.y);
                    bullet.body.velocity.x = 1200;
                }

                bulletTime = game.time.now + 200;
            }
        }
    }

    function resetBullet(bullet) {
        bullet.kill();
    }

    function create() {
        var background = game.add.tileSprite(0, 0, WORLD_WIDTH, WORLD_HEIGHT, 'background');
        game.time.advancedTiming = true;
        game.world.setBounds(0, 0, WORLD_WIDTH, WORLD_HEIGHT);

        bullets = game.add.group();
        bullets.enableBody = true;
        bullets.physicsBodyType = Phaser.Physics.ARCADE;
        bullets.createMultiple(50, 'bullet');
        bullets.setAll('anchor.x', 0.5);
        bullets.setAll('anchor.y', 1);
        bullets.callAll('events.onOutOfBounds.add', 'events.onOutOfBounds', resetBullet);
        bullets.setAll('checkWorldBounds', true);

        // Generate a random name for the user if the user has not choose one.

        var nameValue = sessionStorage.getItem('playerName');
        var playerName = 'user-' + Math.round(Math.random() * 10000);

        if (nameValue != '') {
            playerName = nameValue;
        }

        function joinWorld() {
            socket.emit('join', {
                name: playerName
            }, function (err, playerData) {
                playerId = playerData.id;
                updateCellWatchers(playerData, 'cell-data', handleCellData);
            });
        }

        function removeAllUserSprites() {
            for (var i in users) {
                if (users.hasOwnProperty(i)) {
                    removeUser(users[i]);
                }
            }
        }

        if (socket.state == 'open') {
            joinWorld();
        }
        // For reconnect
        socket.on('connect', joinWorld);
        socket.on('disconnect', removeAllUserSprites);
    }

    var lastActionTime = 0;

    function update() {
        var didAction = false;
        var playerOp = {};
        if (keys.up.isDown) {
            playerOp.u = 1;
            didAction = true;
        }
        if (keys.down.isDown) {
            playerOp.d = 1;
            didAction = true;
        }
        if (keys.right.isDown) {
            playerOp.r = 1;
            didAction = true;
        }
        if (keys.left.isDown) {
            playerOp.l = 1;
            didAction = true;
        }
        if (keys.shoot.isDown) {
            fireBullet();
        }
        if (didAction && Date.now() - lastActionTime >= USER_INPUT_INTERVAL) {
            lastActionTime = Date.now();
            // Send the player operations for the server to process.
            socket.emit('action', playerOp);
        }
    }

    function render() {
        var now = Date.now();

        if (ENVIRONMENT == 'dev') {
            game.debug.text('FPS:   ' + game.time.fps, 2, 14, "#00FF00");
            if (player) {
                game.debug.text('Score: ' + player.score, 2, 30, "#00FF00");
            }
        }

        for (var i in users) {
            if (users.hasOwnProperty(i)) {
                var curUser = users[i];
                if (now - curUser.clientProcessed > PLAYER_INACTIVITY_TIMEOUT) {
                    removeUser(curUser);
                }
            }
        }

        for (var j in coins) {
            if (coins.hasOwnProperty(j)) {
                var curCoin = coins[j];
                if (now - curCoin.clientProcessed > COIN_INACTIVITY_TIMEOUT) {
                    removeCoin(curCoin);
                }
            }
        }
    }
};