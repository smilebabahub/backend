import dotenv from "dotenv";
dotenv.config();

import express from "express";
import helmet from "helmet";
import morgan from "morgan";
import bodyParser from "body-parser";
import cors from "cors";
import cookieParser from "cookie-parser";

import connectDB from "./config/db.js";
import authRoute from "./routes/authRoute.js";
import productRoute from "./routes/productRoute.js";
import paymentRoute from "./routes/paymentRoute.js";

// CONFIGURATIONS
const app = express();

app.use(express.json());
app.use(
  cors({
    origin: "http://localhost:3000",
    credentials: true,
  }),
);
app.use(helmet());
app.use(helmet.crossOriginResourcePolicy({ policy: "cross-origin" }));
app.use(morgan("common"));
app.use(bodyParser.json());
app.use(bodyParser.urlencoded({ extended: false }));
app.use(cookieParser());

app.set("trust proxy", true);
// ROUTES
app.use("/smilebaba/auth", authRoute);
app.use("/smilebaba/products", productRoute);
app.use("/smilebaba/payment", paymentRoute);

const PORT = process.env.PORT || 3001;

// START SERVER
const start = async () => {
  try {
    await connectDB(process.env.MONGO_URI);
    app.listen(PORT, () => {
      console.log(` Server running on port ${PORT}`);
    });
  } catch (error) {
    console.error("Failed to start server:", error);
    process.exit(1);
  }
};

start();
