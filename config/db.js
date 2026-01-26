const mongoose = require("mongoose");

const connectDb = async (uri) => {
  try {
    await mongoose.connect(uri);
    console.log("Database connection established...");
  } catch (error) {
    console.log(error);
  }
};

module.exports = connectDb;
