import "dotenv/config";
import express from "express";
import cors from "cors";
import bodyParser from "body-parser";
import helmet from "helmet";
import morgan from "morgan";
import connectDB from "./config/db.js";
import cookieParser from "cookie-parser";
import authRoute from "./routes/authRoute.js";

//DATA IMPORTS

//CONFIGURATIONS
const app = express();
app.use(express.json());
app.use(helmet());
app.use(helmet.crossOriginResourcePolicy({ policy: "cross-origin" }));
app.use(morgan("common"));
app.use(bodyParser.json());
app.use(bodyParser.urlencoded({ extended: false }));
app.use(cors());

const PORT = process.env.PORT || 3001;

//ROUTES
app.use("/smilebaba/auth", authRoute);

//START SERVER
const start = async () => {
  await connectDB(process.env.MONGO_URI);
  app.listen(PORT, () => {
    console.log(`app is listening on Port: ${PORT}`);
  });
};

start();
