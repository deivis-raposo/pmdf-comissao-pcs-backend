const serverless = require("serverless-http");
const express = require('express');
const mysql = require("mysql2/promise");
const cors = require("cors");

const app = express();
app.use(express.json());
app.use(cors());

const pool = mysql.createPool({
  host: process.env.DB_HOST || "comissaopcsdb.czewyygo05lq.us-east-2.rds.amazonaws.com",
  user: process.env.DB_USER || "admin",
  password: process.env.DB_PASSWORD || "#passDB2025!",
  database: process.env.DB_NAME || "comissaopcsdb",
  waitForConnections: true,
  connectionLimit: 10,
  queueLimit: 0
});

/**
 * Utilitário para resposta padronizada
 */
const sendResponse = (res, success, message, severity, data = null, statusCode = 200) => {
  res.status(statusCode).json({ success, message, severity, data });
};

/**
 * Listar todos CPRs
 */
app.get('/listar-todos-cpr', async (req, res) => {
  let connection;
  try {
    connection = await pool.getConnection();
    const [rows] = await connection.execute(`SELECT * FROM TB_CPR`);
    sendResponse(res, true, "Lista de CPRs carregada com sucesso.", "success", rows);
  } catch (error) {
    console.error("Erro ao listar CPRs:", error);
    sendResponse(res, false, "Erro ao carregar CPRs.", "error", null, 500);
  } finally {
    if (connection) connection.release();
  }
});

/**
 * Listar BPM por CPR
 */
app.get('/listar-bpm-por-cpr', async (req, res) => {
  const { cpr: ID_CPR } = req.query;
  if (!ID_CPR) return sendResponse(res, false, 'Parâmetro "cpr" é obrigatório.', "warning", null, 400);

  let connection;
  try {
    connection = await pool.getConnection();
    const [rows] = await connection.execute(`SELECT ID_BPM, DS_BPM FROM TB_BPM WHERE ID_CPR = ?`, [ID_CPR]);
    sendResponse(res, true, "Lista de BPMs carregada com sucesso.", "success", rows);
  } catch (error) {
    console.error("Erro ao listar BPMs:", error);
    sendResponse(res, false, "Erro ao carregar BPMs.", "error", null, 500);
  } finally {
    if (connection) connection.release();
  }
});

/**
 * Listar PCS por BPM
 */
app.get('/listar-pcs-por-bpm', async (req, res) => {
  const { bpm: ID_BPM } = req.query;
  if (!ID_BPM) return sendResponse(res, false, 'Parâmetro "bpm" é obrigatório.', "warning", null, 400);

  let connection;
  try {
    connection = await pool.getConnection();
    const [rows] = await connection.execute(`SELECT ID_PCS, DS_PCS FROM TB_PCS WHERE ID_BPM = ?`, [ID_BPM]);
    sendResponse(res, true, "Lista de PCS carregada com sucesso.", "success", rows);
  } catch (error) {
    console.error("Erro ao listar PCS:", error);
    sendResponse(res, false, "Erro ao carregar PCS.", "error", null, 500);
  } finally {
    if (connection) connection.release();
  }
});

/**
 * Listar todos patrimônios
 */
app.get('/listar-todos-patrimonios', async (req, res) => {
  let connection;
  try {
    connection = await pool.getConnection();
    const [rows] = await connection.execute(`
      SELECT p.*, c.DS_CPR, b.DS_BPM, s.DS_PCS
      FROM TB_PATRIMONIO p
      LEFT JOIN TB_CPR c ON p.ID_CPR = c.ID_CPR
      LEFT JOIN TB_BPM b ON p.ID_BPM = b.ID_BPM
      LEFT JOIN TB_PCS s ON p.ID_PCS = s.ID_PCS
    `);

    if (rows.length === 0) {
      return sendResponse(res, true, "Nenhum patrimônio encontrado na base de dados.", "info", []);
    }

    sendResponse(res, true, "Lista de patrimônios carregada com sucesso.", "success", rows);
  } catch (error) {
    console.error("Erro ao listar patrimônios:", error);
    sendResponse(res, false, "Erro ao listar patrimônios.", "error", null, 500);
  } finally {
    if (connection) connection.release();
  }
});

/**
 * Consultar patrimônio
 */
app.get('/consultar-patrimonio', async (req, res) => {
  const { cpr, bpm, pcs } = req.query;
  if (!cpr || !bpm || !pcs) {
    return sendResponse(res, false, 'Parâmetros obrigatórios: cpr, bpm, pcs', "warning", null, 400);
  }

  let connection;
  try {
    connection = await pool.getConnection();

    const [rows] = await connection.execute(`
      SELECT ID_PATRIMONIO, TX_LOCALIZACAO, ST_MODULO_LOCALIZADO, ST_BASE_LOCALIZADO, ST_TORRE_LOCALIZADO, TX_OBSERVACAO
      FROM TB_PATRIMONIO
      WHERE ID_CPR = ? AND ID_BPM = ? AND ID_PCS = ?
      LIMIT 1
    `, [cpr, bpm, pcs]);

    if (rows.length === 0) {
      return sendResponse(res, true, "Nenhum patrimônio encontrado para os parâmetros informados.", "info", { encontrado: false });
    }

    const patrimonio = rows[0];
    const [arquivos] = await connection.execute(`
      SELECT ID_ARQUIVO, NM_ARQUIVO, URL_ARQUIVO_BUCKET, TP_ARQUIVO, TAM_ARQUIVO, DT_UPLOAD_ARQUIVO
      FROM TB_ARQUIVO
      WHERE ID_PATRIMONIO = ?
    `, [patrimonio.ID_PATRIMONIO]);

    sendResponse(res, true, "Patrimônio encontrado.", "success", {
      encontrado: true,
      patrimonio: { ...patrimonio, arquivos }
    });
  } catch (error) {
    console.error('Erro ao consultar patrimônio:', error);
    sendResponse(res, false, "Erro ao consultar patrimônio.", "error", null, 500);
  } finally {
    if (connection) connection.release();
  }
});

/**
 * Cadastrar/Atualizar patrimônio
 */
app.post('/cadastrar-patrimonio', async (req, res) => {
  const {
    ID_CPR, ID_BPM, ID_PCS,
    TX_LOCALIZACAO, ST_MODULO_LOCALIZADO, ST_BASE_LOCALIZADO, ST_TORRE_LOCALIZADO,
    TX_OBSERVACAO, arquivos = []
  } = req.body;

  if (!ID_CPR || !ID_BPM || !ID_PCS) {
    return sendResponse(res, false, 'Campos obrigatórios: ID_CPR, ID_BPM, ID_PCS', "warning", null, 400);
  }

  let connection;
  try {
    connection = await pool.getConnection();

    const [patrimonioExistente] = await connection.execute(`
      SELECT ID_PATRIMONIO FROM TB_PATRIMONIO
      WHERE ID_CPR = ? AND ID_BPM = ? AND ID_PCS = ?
      LIMIT 1
    `, [ID_CPR, ID_BPM, ID_PCS]);

    let patrimonioId;
    let msg;

    if (patrimonioExistente.length > 0) {
      patrimonioId = patrimonioExistente[0].ID_PATRIMONIO;
      await connection.execute(`
        UPDATE TB_PATRIMONIO
        SET TX_LOCALIZACAO = ?, ST_MODULO_LOCALIZADO = ?, ST_BASE_LOCALIZADO = ?, 
            ST_TORRE_LOCALIZADO = ?, TX_OBSERVACAO = ?
        WHERE ID_PATRIMONIO = ?
      `, [TX_LOCALIZACAO, ST_MODULO_LOCALIZADO, ST_BASE_LOCALIZADO, ST_TORRE_LOCALIZADO, TX_OBSERVACAO, patrimonioId]);
      msg = 'Patrimônio atualizado com sucesso!';
    } else {
      const [result] = await connection.execute(`
        INSERT INTO TB_PATRIMONIO (
          ID_CPR, ID_BPM, ID_PCS, TX_LOCALIZACAO, ST_MODULO_LOCALIZADO, ST_BASE_LOCALIZADO,
          ST_TORRE_LOCALIZADO, TX_OBSERVACAO
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      `, [ID_CPR, ID_BPM, ID_PCS, TX_LOCALIZACAO, ST_MODULO_LOCALIZADO, ST_BASE_LOCALIZADO, ST_TORRE_LOCALIZADO, TX_OBSERVACAO]);
      patrimonioId = result.insertId;
      msg = 'Patrimônio cadastrado com sucesso!';
    }

    if (arquivos.length > 0) {
      for (const arq of arquivos) {
        await connection.execute(`
          INSERT INTO TB_ARQUIVO (
            ID_PATRIMONIO, NM_ARQUIVO, URL_ARQUIVO_BUCKET, TP_ARQUIVO, TAM_ARQUIVO
          ) VALUES (?, ?, ?, ?, ?)
        `, [patrimonioId, arq.nome, arq.path, arq.tipo, arq.tamanho]);
      }
    }

    sendResponse(res, true, msg, "success", { ID_PATRIMONIO: patrimonioId });
  } catch (error) {
    console.error('Erro ao cadastrar/atualizar patrimônio:', error);
    sendResponse(res, false, "Erro interno ao cadastrar/atualizar patrimônio.", "error", null, 500);
  } finally {
    if (connection) connection.release();
  }
});

module.exports.handler = serverless(app);
