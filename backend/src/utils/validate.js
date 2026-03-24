// backend/src/utils/validate.js
const mongoose = require("mongoose");

/**
 * Returns true if the given id is a valid MongoDB ObjectId.
 * @param {*} id
 * @returns {boolean}
 */
function isValidObjectId(id) {
  return mongoose.Types.ObjectId.isValid(id);
}

module.exports = { isValidObjectId };
