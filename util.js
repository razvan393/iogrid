const _ = require('lodash');

const Util = function (options) {
  this.cellData = options.cellData;
};

Util.prototype.groupStates = function (stateList) {
  stateList.forEach(function (state) {
    if (!state.external) {
      if (!state.pendingGroup) {
        state.pendingGroup = {};
      }
      stateList.forEach(function (memberState) {
        state.pendingGroup[memberState.id] = memberState;
      });
    }
  });
};

Util.prototype.ungroupStates = function (stateList) {
  const self = this;

  stateList.forEach(function (state) {
    if (!state.external && state.pendingGroup) {

      stateList.forEach(function (memberState) {
        delete state.pendingGroup[memberState.id];
        if (_.isEmpty(state.pendingGroup)) {
          delete state.pendingGroup;
        }
      });
    }
  });
};

Util.prototype.ungroupStateFromAll = function (state) {
  const self = this;

  const groupMembers = state.pendingGroup || {};
  const stateUngroupList = [];

  Object.keys(groupMembers).forEach(function (memberId) {
    const cellIndex = state.ccid;
    const type = state.type;

    const memberSimpleState = groupMembers[memberId];
    if (self.cellData[cellIndex] && self.cellData[cellIndex][type]) {
      const memberState = self.cellData[cellIndex][type][memberId];
      if (memberState) {
        stateUngroupList.push(memberState);
      }
    }
  });
  self.ungroupStates(stateUngroupList);
};

module.exports.Util = Util;
