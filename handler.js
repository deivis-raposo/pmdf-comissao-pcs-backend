const serverless = require("serverless-http");
const express = require("express");
const mysql = require("mysql2/promise");
const cors = require("cors");
const { v4: uuidv4 } = require("uuid");

const {
  S3Client,
  PutObjectCommand,
  DeleteObjectCommand
} = require("@aws-sdk/client-s3");

const s3 = new S3Client({ region: process.env.AWS_REGION || "us-east-1" });
const BUCKET_NAME = process.env.BUCKET_NAME || "bucketpmdfcomissaopcs75f9a-dev";

const app = express();

// CORS
app.use(cors({
  origin: "*",
  methods: "GET,POST,PUT,DELETE,OPTIONS",
  allowedHeaders: "Content-Type,Authorization"
}));
app.options("*", (req, res) => {
  res.header("Access-Control-Allow-Origin", "*");
  res.header("Access-Control-Allow-Methods", "GET,POST,PUT,DELETE,OPTIONS");
  res.header("Access-Control-Allow-Headers", "Content-Type,Authorization");
  res.sendStatus(200);
});

// Aceita JSON grande (para Base64)
app.use(express.json({ limit: "50mb" }));

// Conexão MySQL
const pool = mysql.createPool({
  host: process.env.DB_HOST || "comissaopcsdb.czewyygo05lq.us-east-2.rds.amazonaws.com",
  user: process.env.DB_USER || "admin",
  password: process.env.DB_PASSWORD || "#passDB2025!",
  database: process.env.DB_NAME || "comissaopcsdb",
  waitForConnections: true,
  connectionLimit: 10,
  queueLimit: 0
});

const sendResponse = (res, success, message, severity, data = null, statusCode = 200) => {
  res.status(statusCode).json({ success, message, severity, data });
};

// -------------------- ENDPOINTS -------------------- //

// Lista todos CPRs
app.get("/listar-todos-cpr", async (req, res) => {
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

// Lista BPMs por CPR
app.get("/listar-bpm-por-cpr", async (req, res) => {
  const { cpr: ID_CPR } = req.query;
  if (!ID_CPR)
    return sendResponse(res, false, 'Parâmetro "cpr" é obrigatório.', "warning", null, 400);

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

// Lista PCS por BPM
app.get("/listar-pcs-por-bpm", async (req, res) => {
  const { bpm: ID_BPM } = req.query;
  if (!ID_BPM)
    return sendResponse(res, false, 'Parâmetro "bpm" é obrigatório.', "warning", null, 400);

  let connection;
  try {
    connection = await pool.getConnection();
    const [rows] = await connection.execute(`SELECT ID_PCS, DS_PCS FROM TB_PCS WHERE ID_BPM = ?`, [ID_BPM]);
    sendResponse(res, true, "Lista de PCS carregada com sucesso.", "success", rows);
  } catch (error) {
    console.error("Erro ao listar PCS:", error);
    sendResponse(res, false, "Erro ao carregar PCSs.", "error", null, 500);
  } finally {
    if (connection) connection.release();
  }
});

// Lista todos patrimônios
app.get("/listar-todos-patrimonios", async (req, res) => {
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
    sendResponse(res, true, rows.length ? "Lista carregada." : "Nenhum patrimônio encontrado.",
                 rows.length ? "success" : "info", rows);
  } catch (error) {
    console.error("Erro ao listar patrimônios:", error);
    sendResponse(res, false, "Erro ao listar patrimônios.", "error", null, 500);
  } finally {
    if (connection) connection.release();
  }
});

// Consulta patrimônio por CPR/BPM/PCS
app.get("/consultar-patrimonio", async (req, res) => {
  const { cpr, bpm, pcs } = req.query;
  if (!cpr || !bpm || !pcs)
    return sendResponse(res, false, "Parâmetros obrigatórios: cpr, bpm, pcs", "warning", null, 400);

  let connection;
  try {
    connection = await pool.getConnection();

    const [rows] = await connection.execute(
      `SELECT ID_PATRIMONIO, TX_LOCALIZACAO, ST_MODULO_LOCALIZADO, ST_BASE_LOCALIZADO, ST_TORRE_LOCALIZADO, TX_OBSERVACAO
       FROM TB_PATRIMONIO
       WHERE ID_CPR = ? AND ID_BPM = ? AND ID_PCS = ?
       LIMIT 1`,
      [cpr, bpm, pcs]
    );

    if (!rows.length)
      return sendResponse(res, true, "Nenhum patrimônio encontrado.", "info", { encontrado: false });

    const patrimonio = rows[0];
    const [arquivos] = await connection.execute(
      `SELECT ID_ARQUIVO, NM_ARQUIVO, URL_ARQUIVO_BUCKET, TP_ARQUIVO, TAM_ARQUIVO, DT_UPLOAD_ARQUIVO
       FROM TB_ARQUIVO
       WHERE ID_PATRIMONIO = ?`,
      [patrimonio.ID_PATRIMONIO]
    );

    sendResponse(res, true, "Patrimônio encontrado.", "success",
                 { encontrado: true, patrimonio: { ...patrimonio, arquivos } });
  } catch (error) {
    console.error("Erro ao consultar patrimônio:", error);
    sendResponse(res, false, "Erro ao consultar patrimônio.", "error", null, 500);
  } finally {
    if (connection) connection.release();
  }
});

// Cadastra ou atualiza patrimônio (upload Base64)
app.post("/cadastrar-patrimonio", async (req, res) => {
  const {
    ID_CPR, ID_BPM, ID_PCS, TX_LOCALIZACAO,
    ST_MODULO_LOCALIZADO, ST_BASE_LOCALIZADO, ST_TORRE_LOCALIZADO,
    TX_OBSERVACAO, arquivos = []
  } = req.body;

  if (!ID_CPR || !ID_BPM || !ID_PCS)
    return sendResponse(res, false, "Campos obrigatórios: ID_CPR, ID_BPM, ID_PCS", "warning", null, 400);

  let connection;
  try {
    connection = await pool.getConnection();
    const [existente] = await connection.execute(
      `SELECT ID_PATRIMONIO FROM TB_PATRIMONIO WHERE ID_CPR=? AND ID_BPM=? AND ID_PCS=? LIMIT 1`,
      [ID_CPR, ID_BPM, ID_PCS]
    );

    let patrimonioId, msg;
    if (existente.length > 0) {
      patrimonioId = existente[0].ID_PATRIMONIO;
      await connection.execute(
        `UPDATE TB_PATRIMONIO
         SET TX_LOCALIZACAO=?, ST_MODULO_LOCALIZADO=?, ST_BASE_LOCALIZADO=?, ST_TORRE_LOCALIZADO=?, TX_OBSERVACAO=?
         WHERE ID_PATRIMONIO=?`,
        [TX_LOCALIZACAO, ST_MODULO_LOCALIZADO, ST_BASE_LOCALIZADO, ST_TORRE_LOCALIZADO, TX_OBSERVACAO, patrimonioId]
      );
      msg = "Patrimônio atualizado com sucesso!";
    } else {
      const [result] = await connection.execute(
        `INSERT INTO TB_PATRIMONIO (ID_CPR, ID_BPM, ID_PCS, TX_LOCALIZACAO, ST_MODULO_LOCALIZADO, ST_BASE_LOCALIZADO, ST_TORRE_LOCALIZADO, TX_OBSERVACAO)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
        [ID_CPR, ID_BPM, ID_PCS, TX_LOCALIZACAO, ST_MODULO_LOCALIZADO, ST_BASE_LOCALIZADO, ST_TORRE_LOCALIZADO, TX_OBSERVACAO]
      );
      patrimonioId = result.insertId;
      msg = "Patrimônio cadastrado com sucesso!";
    }

    if (arquivos.length) {
      for (const arq of arquivos) {
        const key = `public/${uuidv4()}-${arq.nome}`;
        await s3.send(
          new PutObjectCommand({
            Bucket: BUCKET_NAME,
            Key: key,
            Body: Buffer.from(arq.base64, "base64"),
            ContentType: arq.tipo,
            ACL: "public-read"
          })
        );
        const publicUrl = `https://${BUCKET_NAME}.s3.amazonaws.com/${key}`;
        await connection.execute(
          `INSERT INTO TB_ARQUIVO (ID_PATRIMONIO, NM_ARQUIVO, URL_ARQUIVO_BUCKET, TP_ARQUIVO, TAM_ARQUIVO)
           VALUES (?, ?, ?, ?, ?)`,
          [patrimonioId, arq.nome, publicUrl, arq.tipo, arq.tamanho]
        );
      }
    }

    sendResponse(res, true, msg, "success", { ID_PATRIMONIO: patrimonioId });
  } catch (error) {
    console.error("Erro ao cadastrar/atualizar patrimônio:", error);
    sendResponse(res, false, "Erro interno ao cadastrar/atualizar patrimônio.", "error", null, 500);
  } finally {
    if (connection) connection.release();
  }
});

// Exclui patrimônio e arquivos do S3
app.delete("/excluir-patrimonio", async (req, res) => {
  const { id } = req.query;
  if (!id)
    return sendResponse(res, false, 'Parâmetro "id" é obrigatório.', "warning", null, 400);

  let connection;
  try {
    connection = await pool.getConnection();
    const [arquivos] = await connection.execute(
      `SELECT URL_ARQUIVO_BUCKET FROM TB_ARQUIVO WHERE ID_PATRIMONIO=?`, [id]
    );

    for (const arq of arquivos) {
      try {
        const key = decodeURIComponent(arq.URL_ARQUIVO_BUCKET.split(".amazonaws.com/")[1]);
        await s3.send(new DeleteObjectCommand({ Bucket: BUCKET_NAME, Key: key }));
      } catch (err) {
        console.error("Erro ao remover arquivo do S3:", err);
      }
    }

    await connection.execute(`DELETE FROM TB_ARQUIVO WHERE ID_PATRIMONIO=?`, [id]);
    await connection.execute(`DELETE FROM TB_PATRIMONIO WHERE ID_PATRIMONIO=?`, [id]);

    sendResponse(res, true, "Patrimônio e arquivos excluídos com sucesso.", "success");
  } catch (error) {
    console.error("Erro ao excluir patrimônio:", error);
    sendResponse(res, false, "Erro interno ao excluir patrimônio.", "error", null, 500);
  } finally {
    if (connection) connection.release();
  }
});

// Excluir arquivo individual do S3 e do banco
app.delete("/excluir-arquivo", async (req, res) => {
  const { id } = req.query;
  if (!id)
    return sendResponse(res, false, 'Parâmetro "id" é obrigatório.', "warning", null, 400);

  let connection;
  try {
    connection = await pool.getConnection();
    const [rows] = await connection.execute(
      `SELECT URL_ARQUIVO_BUCKET FROM TB_ARQUIVO WHERE ID_ARQUIVO=? LIMIT 1`, [id]
    );

    if (!rows.length)
      return sendResponse(res, false, "Arquivo não encontrado.", "warning", null, 404);

    const key = decodeURIComponent(rows[0].URL_ARQUIVO_BUCKET.split(".amazonaws.com/")[1]);
    try {
      await s3.send(new DeleteObjectCommand({ Bucket: BUCKET_NAME, Key: key }));
    } catch (err) {
      console.error("Erro ao remover do S3:", err);
    }

    await connection.execute(`DELETE FROM TB_ARQUIVO WHERE ID_ARQUIVO=?`, [id]);
    sendResponse(res, true, "Arquivo excluído com sucesso.", "success");
  } catch (error) {
    console.error("Erro ao excluir arquivo:", error);
    sendResponse(res, false, "Erro interno ao excluir arquivo.", "error", null, 500);
  } finally {
    if (connection) connection.release();
  }
});

module.exports.handler = serverless(app);
