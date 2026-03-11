import mongoose from "mongoose"

const connectDB = async (uri) => {
  try {
    await mongoose.connect(uri);
    console.log("Database connection established...");
  } catch (error) {
    console.log(error);
  }
};

export default connectDB;
