import 'dotenv/config'
import express from 'express'
import helmet from 'helmet'
import morgan from 'morgan'
import bodyParser from 'body-parser'
import  cors  from 'cors'
import { connectDB } from './config/db.js'


//DATA IMPORTS


//CONFIGURATIONS
const app = express()
app.use(express.json())
app.use(cors())
app.use(helmet())
app.use(helmet.crossOriginResourcePolicy({ policy: 'cross-origin'}))
app.use(morgan('common'))
app.use(bodyParser.json())
app.use(bodyParser.urlencoded({ extended: false}))


const PORT = process.env.PORT || 3001;


//ROUTES


//START SERVER
const start = async () => {
  await connectDB(process.env.MONGO_URI)
  app.listen(PORT, () => {
    console.log(`app is listening on Port: ${PORT}`);
  })
}

start()