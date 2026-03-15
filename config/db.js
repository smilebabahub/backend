import mongoose from "mongoose";

mongoose.set("strictQuery", true);

const connectDB = async (uri) => {

  let isConnected = false;


  try {
    if (!uri) {
      console.error(" MONGO_URI is missing in environment variables");
      process.exit(1);
    }

    if (isConnected) return;

    const conn = await mongoose.connect(uri, {
      serverSelectionTimeoutMS: 5000,
      socketTimeoutMS: 45000,
    });
    
    isConnected = conn.connections[0].readyState,

    console.log(` MongoDB Connected: ${conn.connection.host}`);

    // Connection events
    mongoose.connection.on("connected", () => {
      console.log(" Mongoose connected to database");
    });

    mongoose.connection.on("error", (err) => {
      console.error(" MongoDB error:", err);
    });

    mongoose.connection.on("disconnected", () => {
      console.warn(" MongoDB disconnected...");
    });
  } catch (error) {
    console.error(" MongoDB connection failed:", error.message);
    process.exit(1);
  }
};

export default connectDB;
