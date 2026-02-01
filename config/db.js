import mongoose from "mongoose"

const connectDb = async (uri) => {
  try {
    await mongoose.connect(uri);
    console.log("Database connection established...");
  } catch (error) {
    console.log(error);
  }
};

export default connectDb;
