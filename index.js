require("dotenv").config();
const express = require("express");
const helmet = require("helmet");
const morgan = require("morgan");
const bodyParser = require("body-parser");
const cors = require("cors");
const connectDB = require("./config/db.js");
const cookieParser = require("cookie-parser");
const authRoute = require("./routes/authRoute.js");
//DATA IMPORTS

//CONFIGURATIONS
const app = express();
app.use(express.json());
app.use(cors());
app.use(helmet());
app.use(helmet.crossOriginResourcePolicy({ policy: "cross-origin" }));
app.use(morgan("common"));
app.use(bodyParser.json());
app.use(bodyParser.urlencoded({ extended: false }));
app.use(cookieParser());

app.use("/smilebaba/auth", authRoute);

const PORT = process.env.PORT || 3001;

//ROUTES

//START SERVER
const start = async () => {
  await connectDB(process.env.MONGO_URI);
  app.listen(PORT, () => {
    console.log(`app is listening on Port: ${PORT}`);
  });
};

start();
