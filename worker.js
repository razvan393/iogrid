const _ = require('lodash');
const express = require('express');
const serveStatic = require('serve-static');
const path = require('path');
const morgan = require('morgan');
const healthChecker = require('sc-framework-health-check');
const StateManager = require('./state-manager').StateManager;
const uuid = require('uuid');
const ChannelGrid = require('./public/channel-grid').ChannelGrid;
const Util = require('./util').Util;
const scCodecMinBin = require('sc-codec-min-bin');

const config = require('./config');
const CellController = require('./cell');

const WORLD_WIDTH = config.WORLD_WIDTH;
const WORLD_HEIGHT = config.WORLD_HEIGHT;
const WORLD_CELL_WIDTH = config.WORLD_CELL_WIDTH;
const WORLD_CELL_HEIGHT = config.WORLD_CELL_HEIGHT;
const WORLD_COLS = Math.ceil(WORLD_WIDTH / WORLD_CELL_WIDTH);
const WORLD_ROWS = Math.ceil(WORLD_HEIGHT / WORLD_CELL_HEIGHT);
const WORLD_CELLS = WORLD_COLS * WORLD_ROWS;
const WORLD_CELL_OVERLAP_DISTANCE = config.WORLD_CELL_OVERLAP_DISTANCE;
const WORLD_UPDATE_INTERVAL = config.WORLD_UPDATE_INTERVAL;
const WORLD_STALE_TIMEOUT = config.WORLD_STALE_TIMEOUT;
const SPECIAL_UPDATE_INTERVALS = config.SPECIAL_UPDATE_INTERVALS;

const PLAYER_DIAMETER = config.PLAYER_DIAMETER;
const PLAYER_MASS = config.PLAYER_MASS;

const OUTBOUND_STATE_TRANSFORMERS = config.OUTBOUND_STATE_TRANSFORMERS;

const CHANNEL_INBOUND_CELL_PROCESSING = 'internal/cell-processing-inbound';
const CHANNEL_CELL_TRANSITION = 'internal/cell-transition';

const game = {
  stateRefs: {}
};

function getRandomPosition(spriteWidth, spriteHeight) {
  const halfSpriteWidth = spriteWidth / 2;
  const halfSpriteHeight = spriteHeight / 2;
  const widthRandomness = WORLD_WIDTH - spriteWidth;
  const heightRandomness = WORLD_HEIGHT - spriteHeight;
  return {
    x: Math.round(halfSpriteWidth + widthRandomness * Math.random()),
    y: Math.round(halfSpriteHeight + heightRandomness * Math.random())
  };
}

module.exports.run = function (worker) {
  console.log('   >> Worker PID:', process.pid);

  // We use a codec for SC to compress messages between clients and the server
  // to a lightweight binary format to reduce bandwidth consumption.
  // We should probably make our own codec (on top of scCodecMinBin) to compress
  // world-specific entities. For example, instead of emitting the JSON:
  // {id: '...', width: 200, height: 200}
  // We could compress it down to something like: {id: '...', w: 200, h: 200, c: 1000}
  worker.scServer.setCodecEngine(scCodecMinBin);

  const environment = worker.options.environment;
  const serverWorkerId = worker.options.instanceId + ':' + worker.id;

  const app = express();

  const httpServer = worker.httpServer;
  const scServer = worker.scServer;

  if (environment == 'dev') {
    // Log every HTTP request. See https://github.com/expressjs/morgan for other
    // available formats.
    app.use(morgan('dev'));
  }
  app.use(serveStatic(path.resolve(__dirname, 'public')));

  // Add GET /health-check express route
  healthChecker.attach(worker, app);

  httpServer.on('request', app);

  scServer.addMiddleware(scServer.MIDDLEWARE_SUBSCRIBE, function (req, next) {
    if (req.channel.indexOf('internal/') === 0) {
      const err = new Error('Clients are not allowed to subscribe to the ' + req.channel + ' channel.');
      err.name = 'ForbiddenSubscribeError';
      next(err);
    } else {
      next();
    }
  });

  scServer.addMiddleware(scServer.MIDDLEWARE_PUBLISH_IN, function (req, next) {
    // Only allow clients to publish to channels whose names start with 'external/'
    if (req.channel.indexOf('external/') === 0) {
      next();
    } else {
      const err = new Error('Clients are not allowed to publish to the ' + req.channel + ' channel.');
      err.name = 'ForbiddenPublishError';
      next(err);
    }
  });

  // This allows us to break up our channels into a grid of cells which we can
  // watch and publish to individually.
  // It handles most of the data distribution automatically so that it reaches
  // the intended cells.
  const channelGrid = new ChannelGrid({
    worldWidth: WORLD_WIDTH,
    worldHeight: WORLD_HEIGHT,
    cellOverlapDistance: WORLD_CELL_OVERLAP_DISTANCE,
    rows: WORLD_ROWS,
    cols: WORLD_COLS,
    exchange: scServer.exchange
  });

  const stateManager = new StateManager({
    stateRefs: game.stateRefs,
    channelGrid: channelGrid
  });

  if (WORLD_CELLS % worker.options.workers !== 0) {
    const errorMessage = 'The number of cells in your world (determined by WORLD_WIDTH, WORLD_HEIGHT, WORLD_CELL_WIDTH, WORLD_CELL_HEIGHT)' +
        ' should share a common factor with the number of workers or else the workload might get duplicated for some cells.';
    console.error(errorMessage);
  }

  const cellsPerWorker = WORLD_CELLS / worker.options.workers;

  const cellData = {};
  const cellPendingDeletes = {};
  const cellExternalStates = {};

  const util = new Util({
    cellData: cellData
  });

  const cellControllers = {};
  const updateIntervals = {};
  const cellSpecialIntervalTypes = {};

  for (let h = 0; h < cellsPerWorker; h++) {
    const cellIndex = worker.id + h * worker.options.workers;
    cellData[cellIndex] = {};
    cellPendingDeletes[cellIndex] = {};
    cellExternalStates[cellIndex] = {};

    cellControllers[cellIndex] = new CellController({
      cellIndex: cellIndex,
      cellData: cellData[cellIndex],
      cellBounds: channelGrid.getCellBounds(cellIndex),
      worker: worker
    }, util);

    channelGrid.watchCellAtIndex(CHANNEL_INBOUND_CELL_PROCESSING, cellIndex, gridCellDataHandler.bind(null, cellIndex));
    channelGrid.watchCellAtIndex(CHANNEL_CELL_TRANSITION, cellIndex, gridCellTransitionHandler.bind(null, cellIndex));
  }

  function applyOutboundStateTransformer(state) {
    const type = state.type;
    if (OUTBOUND_STATE_TRANSFORMERS[type]) {
      return OUTBOUND_STATE_TRANSFORMERS[type](state);
    }
    return state;
  }

  function setUpdateIntervals(intervalMap) {
    Object.keys(intervalMap).forEach(function (interval) {
      const intervalNumber = parseInt(interval);

      intervalMap[interval].forEach(function (type) {
        cellSpecialIntervalTypes[type] = true;
      });

      updateIntervals[interval] = setInterval(function () {
        const transformedStateList = [];

        Object.keys(cellData).forEach(function (cellIndex) {
          const currentCellData = cellData[cellIndex];

          intervalMap[interval].forEach(function (type) {
            Object.keys(currentCellData[type] || {}).forEach(function (id) {
              transformedStateList.push(
                applyOutboundStateTransformer(currentCellData[type][id])
              );
            });
          });
        });
        // External channel which clients can subscribe to.
        // It will publish to multiple channels based on each state's
        // (x, y) coordinates.
        if (transformedStateList.length) {
          channelGrid.publish('cell-data', transformedStateList);
        }
      }, intervalNumber);
    });
  }

  setUpdateIntervals(SPECIAL_UPDATE_INTERVALS);

  function getSimplifiedState(state) {
    return {
      type: state.type,
      x: Math.round(state.x),
      y: Math.round(state.y)
    };
  }

  function isGroupABetterThanGroupB(groupA, groupB) {
    // If both groups are the same size, the one that has the leader
    // with the lowest alphabetical id wins.
    return groupA.leader.id <= groupB.leader.id;
  }

  /*
    Groups are not passed around between cells/processes. Their purpose is to allow
    states to seamlessly interact with one another across cell boundaries.

    When one state affects another state across cell boundaries (e.g. one player
    pushing another player into a different cell), there is a slight delay for
    the position information to be shared across processes/CPU cores; as a
    result of this, the states may not show up in the exact same position in both cells.
    When two cells report slightly different positions for the same set of
    states, it may cause overlapping and flickering on the front end since the
    front end doesn't know which data to trust.

    A group allows two cells to agree on which cell is responsible for broadcasting the
    position of states that are within the group by considering the group's average position
    instead of looking at the position of member states individually.
  */
  function getStateGroups() {
    const groupMap = {};
    Object.keys(cellData).forEach(function (cellIndex) {
      if (!groupMap[cellIndex]) {
        groupMap[cellIndex] = {};
      }
      const currentCellData = cellData[cellIndex];
      const currentGroupMap = groupMap[cellIndex];
      Object.keys(currentCellData).forEach(function (type) {
        const cellDataStates = currentCellData[type] || {};
        Object.keys(cellDataStates).forEach(function (id) {
          const state = cellDataStates[id];
          if (state.group) {
            const groupSimpleStateMap = {};
            Object.keys(state.group).forEach(function (stateId) {
              groupSimpleStateMap[stateId] = state.group[stateId];
            });

            const groupStateIdList = Object.keys(groupSimpleStateMap).sort();
            const groupId = groupStateIdList.join(',');

            const leaderClone = _.cloneDeep(state);
            leaderClone.x = groupSimpleStateMap[leaderClone.id].x;
            leaderClone.y = groupSimpleStateMap[leaderClone.id].y;

            const group = {
              id: groupId,
              leader: state,
              members: [],
              size: 0,
              x: 0,
              y: 0,
            };
            const expectedMemberCount = groupStateIdList.length;

            for (let i = 0; i < expectedMemberCount; i++) {
              const memberId = groupStateIdList[i];
              const memberSimplifiedState = groupSimpleStateMap[memberId];
              const memberState = currentCellData[memberSimplifiedState.type][memberId];
              if (memberState) {
                const memberStateClone = _.cloneDeep(memberState);
                memberStateClone.x = memberSimplifiedState.x;
                memberStateClone.y = memberSimplifiedState.y;
                group.members.push(memberStateClone);
                group.x += memberStateClone.x;
                group.y += memberStateClone.y;
                group.size++;
              }
            }
            if (group.size) {
              group.x = Math.round(group.x / group.size);
              group.y = Math.round(group.y / group.size);
            }

            const allGroupMembersAreAvailableToThisCell = group.size >= expectedMemberCount;
            const existingGroup = currentGroupMap[groupId];
            if (allGroupMembersAreAvailableToThisCell &&
              (!existingGroup || isGroupABetterThanGroupB(group, existingGroup))) {

              group.tcid = channelGrid.getCellIndex(group);
              currentGroupMap[groupId] = group;
            }
          }
        });
      });
    });
    return groupMap;
  }

  function prepareStatesForProcessing(cellIndex) {
    const currentCellData = cellData[cellIndex];
    const currentCellExternalStates = cellExternalStates[cellIndex];

    Object.keys(currentCellData).forEach(function (type) {
      const cellDataStates = currentCellData[type] || {};
      Object.keys(cellDataStates).forEach(function (id) {
        const state = cellDataStates[id];

        if (state.external) {
          if (!currentCellExternalStates[type]) {
            currentCellExternalStates[type] = {};
          }
          currentCellExternalStates[type][id] = _.cloneDeep(state);
        }
      });
    });
  }

  // We should never modify states which belong to other cells or
  // else it will result in conflicts and lost states. This function
  // restores them to their pre-processed condition.
  function restoreExternalStatesBeforeDispatching(cellIndex) {
    const currentCellData = cellData[cellIndex];
    const currentCellExternalStates = cellExternalStates[cellIndex];

    Object.keys(currentCellExternalStates).forEach(function (type) {
      const externalStatesList = currentCellExternalStates[type];
      Object.keys(externalStatesList).forEach(function (id) {
        currentCellData[type][id] = externalStatesList[id];
        delete externalStatesList[id];
      });
    });
  }

  function prepareGroupStatesBeforeDispatching(cellIndex) {
    const currentCellData = cellData[cellIndex];
    Object.keys(currentCellData).forEach(function (type) {
      const cellDataStates = currentCellData[type] || {};
      Object.keys(cellDataStates).forEach(function (id) {
        const state = cellDataStates[id];
        if (state.pendingGroup) {
          const serializedMemberList = {};
          Object.keys(state.pendingGroup).forEach(function (memberId) {
            const memberState = state.pendingGroup[memberId];
            serializedMemberList[memberId] = getSimplifiedState(memberState);
          });
          state.group = serializedMemberList;
          delete state.pendingGroup;
        } else if (state.group) {
          delete state.group;
        }
      });
    });
  }

  // Remove decorator functions which were added to the states temporarily
  // for use within the cell controller.
  function cleanupStatesBeforeDispatching(cellIndex) {
    const currentCellData = cellData[cellIndex];

    Object.keys(currentCellData).forEach(function (type) {
      const cellDataStates = currentCellData[type] || {};
      Object.keys(cellDataStates).forEach(function (id) {
        const state = cellDataStates[id];

        if (state.op) {
          delete state.op;
        }
      });
    });
  }

  // Main world update loop.
  setInterval(function () {
    const cellIndexList = Object.keys(cellData);
    const transformedStateList = [];

    cellIndexList.forEach(function (cellIndex) {
      cellIndex = Number(cellIndex);
      prepareStatesForProcessing(cellIndex);
      cellControllers[cellIndex].run(cellData[cellIndex]);
      prepareGroupStatesBeforeDispatching(cellIndex);
      cleanupStatesBeforeDispatching(cellIndex);
      restoreExternalStatesBeforeDispatching(cellIndex);
      dispatchProcessedData(cellIndex);
    });

    const groupMap = getStateGroups();

    cellIndexList.forEach(function (cellIndex) {
      cellIndex = Number(cellIndex);
      const currentCellData = cellData[cellIndex];
      Object.keys(currentCellData).forEach(function (type) {
        if (!cellSpecialIntervalTypes[type]) {
          const cellDataStates = currentCellData[type] || {};
          Object.keys(cellDataStates).forEach(function (id) {
            const state = cellDataStates[id];
            if (!state.group && !state.external &&
              (!cellPendingDeletes[cellIndex][type] || !cellPendingDeletes[cellIndex][type][id])) {

              transformedStateList.push(
                applyOutboundStateTransformer(state)
              );
            }
          });
        }
      });
    });

    // Deletions are processed as part of WORLD_UPDATE_INTERVAL even if
    // that type has its own special interval.
    Object.keys(cellPendingDeletes).forEach(function (cellIndex) {
      cellIndex = Number(cellIndex);
      const currentCellDeletes = cellPendingDeletes[cellIndex];
      Object.keys(currentCellDeletes).forEach(function (type) {
        const cellDeleteStates = currentCellDeletes[type] || {};
        Object.keys(cellDeleteStates).forEach(function (id) {
          // These states should already have a delete property which
          // can be used on the client-side to delete items from the view.
          transformedStateList.push(
            applyOutboundStateTransformer(cellDeleteStates[id])
          );
          delete cellDeleteStates[id];
        });
      });
    });

    Object.keys(groupMap).forEach(function (cellIndex) {
      cellIndex = Number(cellIndex);
      const currentGroupMap = groupMap[cellIndex];
      Object.keys(currentGroupMap).forEach(function (groupId) {
        const group = currentGroupMap[groupId];
        const memberList = group.members;
        if (group.tcid === cellIndex) {
          memberList.forEach(function (member) {
            transformedStateList.push(
              applyOutboundStateTransformer(member)
            );
          });
        }
      });
    });

    // External channel which clients can subscribe to.
    // It will publish to multiple channels based on each state's
    // (x, y) coordinates.
    if (transformedStateList.length) {
      channelGrid.publish('cell-data', transformedStateList);
    }

  }, WORLD_UPDATE_INTERVAL);

  function forEachStateInDataTree(dataTree, callback) {
    const typeList = Object.keys(dataTree);

    typeList.forEach(function (type) {
      const stateList = dataTree[type];
      const ids = Object.keys(stateList);

      ids.forEach(function (id) {
        callback(stateList[id]);
      });
    });
  }

  function updateStateExternalTag(state, cellIndex) {
    if (state.ccid !== cellIndex || state.tcid !== cellIndex) {
      state.external = true;
    } else {
      delete state.external;
    }
  }

  // Share states with adjacent cells when those states get near
  // other cells' boundaries and prepare for transition to other cells.
  // This logic is quite complex so be careful when changing any code here.
  function dispatchProcessedData(cellIndex) {
    const now = Date.now();
    const currentCellData = cellData[cellIndex];
    const workerStateRefList = {};
    const statesForNearbyCells = {};

    forEachStateInDataTree(currentCellData, function (state) {
      const id = state.id;
      const swid = state.swid;
      const type = state.type;

      if (!state.external) {
        if (state.version != null) {
          state.version++;
        }
        state.processed = now;
      }

      // The target cell id
      state.tcid = channelGrid.getCellIndex(state);

      // For newly created states (those created from inside the cell).
      if (state.ccid == null) {
        state.ccid = cellIndex;
        state.version = 1;
      }
      updateStateExternalTag(state, cellIndex);

      if (state.ccid === cellIndex) {
        const nearbyCellIndexes = channelGrid.getAllCellIndexes(state);
        nearbyCellIndexes.forEach(function (nearbyCellIndex) {
          if (!statesForNearbyCells[nearbyCellIndex]) {
            statesForNearbyCells[nearbyCellIndex] = [];
          }
          // No need for the cell to send states to itself.
          if (nearbyCellIndex !== cellIndex) {
            statesForNearbyCells[nearbyCellIndex].push(state);
          }
        });

        if (state.tcid !== cellIndex && swid) {
          if (!workerStateRefList[swid]) {
            workerStateRefList[swid] = [];
          }
          var stateRef = {
            id: state.id,
            swid: state.swid,
            tcid: state.tcid,
            type: state.type
          };

          if (state.delete) {
            stateRef.delete = state.delete;
          }
          workerStateRefList[swid].push(stateRef);
        }
      }

      if (state.delete) {
        if (!cellPendingDeletes[cellIndex][type]) {
          cellPendingDeletes[cellIndex][type] = {};
        }
        cellPendingDeletes[cellIndex][type][id] = state;
        delete currentCellData[type][id];
      }
      if (now - state.processed > WORLD_STALE_TIMEOUT) {
        delete currentCellData[type][id];
      }
    });

    const workerCellTransferIds = Object.keys(workerStateRefList);
    workerCellTransferIds.forEach(function (swid) {
      scServer.exchange.publish('internal/input-cell-transition/' + swid, workerStateRefList[swid]);
    });

    // Pass states off to adjacent cells as they move across grid cells.
    const allNearbyCellIndexes = Object.keys(statesForNearbyCells);
    allNearbyCellIndexes.forEach(function (nearbyCellIndex) {
      channelGrid.publishToCells(CHANNEL_CELL_TRANSITION, statesForNearbyCells[nearbyCellIndex], [nearbyCellIndex]);
    });
  }

  // Receive states which are in other cells and *may* transition to this cell later.
  // We don't manage these states, we just keep a copy so that they are visible
  // inside our cellController (cell.js) - This allows states to interact across
  // cell partitions (which may be hosted on a different process/CPU core).
  function gridCellTransitionHandler(cellIndex, stateList) {
    const currentCellData = cellData[cellIndex];

    stateList.forEach(function (state) {
      const type = state.type;
      const id = state.id;

      if (!currentCellData[type]) {
        currentCellData[type] = {};
      }
      let existingState = currentCellData[type][id];

      if (!existingState || state.version > existingState.version) {
        // Do not overwrite a state which is in the middle of
        // being synchronized with a different cell.
        if (state.tcid === cellIndex) {
          // This is a full transition to our current cell.
          state.ccid = cellIndex;
          currentCellData[type][id] = state;
        } else {
          // This is just external state for us to track but not
          // a complete transition, the state will still be managed by
          // a different cell.
          currentCellData[type][id] = state;
        }
        updateStateExternalTag(state, cellIndex);
      }

      existingState = currentCellData[type][id];
      existingState.processed = Date.now();
    });
  }

  // Here we handle and prepare data for a single cell within our game grid to be
  // processed by our cell controller.
  function gridCellDataHandler(cellIndex, stateList) {
    const currentCellData = cellData[cellIndex];

    stateList.forEach(function (stateRef) {
      const id = stateRef.id;
      const type = stateRef.type;

      if (!currentCellData[type]) {
        currentCellData[type] = {};
      }

      if (!currentCellData[type][id]) {
        let state;
        if (stateRef.create) {
          // If it is a stateRef, we get the state from the create property.
          state = stateRef.create;
        } else if (stateRef.x != null && stateRef.y != null) {
          // If we have x and y properties, then we know that
          // this is a full state already (probably created directly inside the cell).
          state = stateRef;
        } else {
          throw new Error('Received an invalid state reference');
        }
        state.ccid = cellIndex;
        state.version = 1;
        currentCellData[type][id] = state;
      }
      const cachedState = currentCellData[type][id];
      if (cachedState) {
        if (stateRef.op) {
          cachedState.op = stateRef.op;
        }
        if (stateRef.delete) {
          cachedState.delete = stateRef.delete;
        }
        if (stateRef.data) {
          cachedState.data = stateRef.data;
        }
        cachedState.tcid = channelGrid.getCellIndex(cachedState);
        updateStateExternalTag(cachedState, cellIndex);
        cachedState.processed = Date.now();
      }
    });
  }

  scServer.exchange.subscribe('internal/input-cell-transition/' + serverWorkerId)
  .watch(function (stateList) {
    stateList.forEach(function (state) {
      game.stateRefs[state.id] = state;
    });
  });

  // This is the main input loop which feeds states into various cells
  // based on their (x, y) coordinates.
  function processInputStates() {
    const stateList = [];
    const stateIds = Object.keys(game.stateRefs);

    stateIds.forEach(function (id) {
      const state = game.stateRefs[id];
      // Don't include bots.
      stateList.push(state);
    });

    // Publish to internal channels for processing (e.g. Collision
    // detection and resolution, scoring, etc...)
    // These states will be processed by a cell controllers depending
    // on each state's target cell index (tcid) within the world grid.
    const gridPublishOptions = {
      cellIndexesFactory: function (state) {
        return [state.tcid];
      }
    };
    channelGrid.publish(CHANNEL_INBOUND_CELL_PROCESSING, stateList, gridPublishOptions);

    stateList.forEach(function (state) {
      if (state.op) {
        delete state.op;
      }
      if (state.delete) {
        delete game.stateRefs[state.id];
      }
    });
  }

  setInterval(processInputStates, WORLD_UPDATE_INTERVAL);

  /*
    In here we handle our incoming realtime connections and listen for events.
  */
  scServer.on('connection', function (socket) {

    socket.on('getWorldInfo', function (data, respond) {
      // The first argument to respond can optionally be an Error object.
      respond(null, {
        width: WORLD_WIDTH,
        height: WORLD_HEIGHT,
        cols: WORLD_COLS,
        rows: WORLD_ROWS,
        cellWidth: WORLD_CELL_WIDTH,
        cellHeight: WORLD_CELL_HEIGHT,
        cellOverlapDistance: WORLD_CELL_OVERLAP_DISTANCE,
        serverWorkerId: serverWorkerId,
        environment: environment
      });
    });

    socket.on('join', function (playerOptions, respond) {
      const startingPos = getRandomPosition(PLAYER_DIAMETER, PLAYER_DIAMETER);
      const player = {
        id: uuid.v4(),
        type: 'player',
        swid: serverWorkerId,
        name: playerOptions.name,
        x: startingPos.x,
        y: startingPos.y,
        diam: PLAYER_DIAMETER,
        mass: PLAYER_MASS,
        score: 0
      };

      socket.player = stateManager.create(player);

      respond(null, player);
    });

    socket.on('action', function (playerOp) {
      if (socket.player) {
        stateManager.update(socket.player, playerOp);
      }
    });

    socket.on('disconnect', function () {
      if (socket.player) {
        stateManager.delete(socket.player);
      }
    });
  });
};
