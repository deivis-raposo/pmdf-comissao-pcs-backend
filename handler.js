const serverless = require("serverless-http");
const express = require('express');
const mysql = require("mysql2/promise");
const bodyParser = require("body-parser");
const app = express();
const cors = require("cors");
app.use(express.json());
app.use(cors());


const pool = mysql.createPool({
  host: "comissaopcsdb.czewyygo05lq.us-east-2.rds.amazonaws.com",
  user: "admin",
  password: "#passDB2025!",
  database: "comissaopcsdb",
  waitForConnections: true,
  connectionLimit: 10,
  queueLimit: 0
});

app.get("/", (req, res, next) => {
  return res.status(200).json({
    message: "Hello from root!",
  });
});

app.get("/hello", (req, res, next) => {
  return res.status(200).json({
    message: "Hello from path!",
  });
});

//listar todos CPRs
app.get('/listar-todos-cpr', async (req, res, next) => {
  try {
    const connection = await pool.getConnection();
    const selectQuery = `select * from comissaopcsdb.TB_CPR`;
    const [rows, fields] = await connection.execute(selectQuery);
    res.status(200).json({
      response: rows
    });
    connection.release();
  } catch (error) {
    console.error("Erro ao listar todos CPR's cadastrados:", error);
    res.status(500).json({ message: "Erro ao listar CPR's." });
  }
});

/// Listar todos os PCS de determinado CPR
app.get('/listar-pcs-por-cpr', async (req, res) => {
  const { cpr: ID_CPR } = req.query;

  if (!ID_CPR) {
    return res.status(400).json({ message: 'Parâmetro "cpr" (ID_CPR) é obrigatório.' });
  }

  try {
    const connection = await pool.getConnection();

    const selectQuery = `SELECT ID_PCS, DS_PCS FROM comissaopcsdb.TB_PCS WHERE ID_CPR = ?`;
    const [rows] = await connection.execute(selectQuery, [ID_CPR]);
    
    connection.release();

    res.status(200).json({
      response: rows
    });
  } catch (error) {
    console.error("Erro ao listar PCS por CPR:", error);
    res.status(500).json({ message: "Erro ao listar PCS." });
  }
});



//listar todos patrimonios
app.get('/listar-todos-patrimonios', async (req, res, next) => {
  try {
    const connection = await pool.getConnection();
    const selectQuery = `select * from comissaopcsdb.TB_PATRIMONIO`;
    const [rows, fields] = await connection.execute(selectQuery);
    res.status(200).json({
      response: rows
    });
    connection.release();
  } catch (error) {
    console.error("Erro ao listar todos patrimônios cadastrados:", error);
    res.status(500).json({ message: "Erro ao listar patrimônios." });
  }
});

//cadastrar patrimonio
app.post('/cadastrar-patrimonio', async function(req, res) {
  const {
    id_unidade,
    id_pcs,
    tx_localizacao,
    st_modulo,
    st_base,
    st_torre,
    tx_informacoes,
    id_arquivo_modulo = null,
    id_arquivo_base = null,
    id_arquivo_torre = null,
    id_arquivo_diversos = null
  } = req.body;
  
  try {
    console.log("Body recebido:", req.body);
    const connection = await pool.getConnection();
    const insertQuery = `INSERT INTO comissaopcsdb.tb_inventario (
                              id_inventario, id_unidade, id_pcs, tx_localizacao, st_modulo, st_base, st_torre, tx_informacoes,
                              id_arquivo_modulo, id_arquivo_base, id_arquivo_torre, id_arquivo_diversos
                            ) VALUES (
                              null, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?
                            );`;

    const values = [  id_unidade,
                      id_pcs,
                      tx_localizacao,
                      st_modulo,
                      st_base,
                      st_torre,
                      tx_informacoes,
                      id_arquivo_modulo,
                      id_arquivo_base,
                      id_arquivo_torre,
                      id_arquivo_diversos ];

    const [rows, fields] = await connection.execute(insertQuery, values);
    res.status(200).json({ message: "Patrimônio cadastrado com sucesso!" });
    connection.release();
  } catch (error) {
    console.error("Erro ao inserir patrimônio:", error);
    res.status(500).json({
      message: "Erro ao cadastrar patrimônio.",
      error: error.message,
    });
  }
});


app.use((req, res, next) => {
  return res.status(404).json({
    error: "Not Found",
  });
});

exports.handler = serverless(app);
