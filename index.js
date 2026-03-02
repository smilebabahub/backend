import dotenv from "dotenv";
dotenv.config();

import express from "express";
import helmet from "helmet";
import morgan from "morgan";
import bodyParser from "body-parser";
import cors from "cors";
import cookieParser from "cookie-parser";
import http from "http";
import { Server } from "socket.io";

import connectDB from "./config/db.js";
import authRoute from "./routes/authRoute.js";
//import adRoute from "./routes/adRoute.js";
import productRoute from "./routes/productRoute.js";
import paymentRoute from "./routes/paymentRoute.js";
import { Socket } from "dgram";

//CONFIGURATIONS
const app = express();

const server = http.createServer(app);

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
// app.use("/smilebaba/ads", adRoute);
app.use("/smilebaba/products", productRoute);
app.use("/smilebaba/payment", paymentRoute);

const PORT = process.env.PORT || 3001;

//creating socket server
const io = new Server(server, {
  cors: {
    origin: "http://localhost:5173",
    methods: ["POST", "GET"],
  },
});

io.on("connection", (Socket) => {
  console.log(`a user connected with id ${Socket.id}`);

  Socket.on("send_message", (data) => {
    console.log("message received:", data);
    Socket.broadcast.emit("receive_message", data);
  });
});

// START SERVER
const start = async () => {
  try {
    await connectDB(process.env.MONGO_URI);
    server.listen(PORT, () => {
      console.log(` Server running on port ${PORT}`);
    });
  } catch (error) {
    console.error("Failed to start server:", error);
    process.exit(1);
  }
};

start();
