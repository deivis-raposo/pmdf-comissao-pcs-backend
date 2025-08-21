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

// ====== PDF & Utilidades ======
const PDFDocument = require("pdfkit");
const QRCode = require("qrcode");
const axiosHttp = require("axios"); // baixar logo e imagens públicas
// ==============================

const s3 = new S3Client({ region: process.env.AWS_REGION || "us-east-1" });
const BUCKET_NAME = process.env.BUCKET_NAME || "bucketpmdfcomissaopcs75f9a-dev";
const LOGO_URL = process.env.LOGO_URL || ""; // URL pública do brasão/logo (PNG/JPG)

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

// ---------------------------------------------------------------------
// Helpers para o PDF
// ---------------------------------------------------------------------
function drawLabelValue(doc, label, value, x, y, labelWidth = 140, lineHeight = 18) {
  const right = doc.page.width - doc.page.margins.right;
  const gap = 6;

  const labelX = x;
  const valueX = x + labelWidth + gap;

  // largura disponível para o texto do valor até a margem direita
  const valueWidth = Math.max(10, right - valueX);

  // Label (geralmente 1 linha)
  doc.font("Helvetica-Bold").fontSize(10)
     .text(label, labelX, y, { width: labelWidth });

  // Valor (pode quebrar em múltiplas linhas)
  doc.font("Helvetica").fontSize(10)
     .text((value ?? "-").toString(), valueX, y, { width: valueWidth });

  // doc.y agora está no final do bloco de "valor"
  // Avançamos o cursor respeitando a altura real renderizada
  const nextY = Math.max(y + lineHeight, doc.y);

  // pequeno espaçamento extra entre linhas (opcional)
  return nextY + 4;
}


async function fetchBuffer(url) {
  const res = await axiosHttp.get(url, { responseType: "arraybuffer" });
  return Buffer.from(res.data);
}

// Renderiza imagens 2 por página A4 (retrato), cada uma metade da página
async function renderImagesTwoPerPage(doc, imagensUrls) {
  if (!imagensUrls.length) return;

  const left = doc.page.margins.left;
  const right = doc.page.width - doc.page.margins.right;
  const top = doc.page.margins.top;
  const bottom = doc.page.height - doc.page.margins.bottom;
  const contentWidth = right - left;

  let isFirstImagesPage = true;

  const gapBetweenSlots = 18; // espaço entre as metades
  const titleGap = 10;
  const slotTopPadding = 8;
  const slotBottomPadding = 8;
  const sidePadding = 0;

  async function drawImageInSlot(imgUrl, slotTopY, slotBottomY) {
    const availWidth = contentWidth - 2 * sidePadding;
    const availHeight = (slotBottomY - slotTopY) - (slotTopPadding + slotBottomPadding);
    const imgBuffer = await fetchBuffer(imgUrl);
    const x = left + sidePadding;
    const y = slotTopY + slotTopPadding;
    doc.image(imgBuffer, x, y, { fit: [availWidth, availHeight], align: 'center', valign: 'center' });
  }

  for (let i = 0; i < imagensUrls.length; i += 2) {
    doc.addPage();
    let yCursor = top;

    if (isFirstImagesPage) {
      doc.font("Helvetica-Bold").fontSize(11).text("Anexos (imagens):", left, yCursor);
      yCursor = doc.y + titleGap;
      isFirstImagesPage = false;
    }

    const totalAvailHeight = bottom - yCursor;
    const slotHeight = (totalAvailHeight - gapBetweenSlots) / 2;

    const slot1Top = yCursor;
    const slot1Bottom = slot1Top + slotHeight;

    const slot2Top = slot1Bottom + gapBetweenSlots;
    const slot2Bottom = slot2Top + slotHeight;

    try { await drawImageInSlot(imagensUrls[i], slot1Top, slot1Bottom); } catch(_) {}
    if (i + 1 < imagensUrls.length) {
      try { await drawImageInSlot(imagensUrls[i + 1], slot2Top, slot2Bottom); } catch(_) {}
    }
  }
}

async function makePatrimonioPDF({ patrimonio, arquivos, reportUrl, titulo = "Relatório de Patrimônio" }) {
  return await new Promise(async (resolve, reject) => {
    const doc = new PDFDocument({ size: "A4", margins: { top: 40, left: 50, right: 50, bottom: 40 } });
    const chunks = [];
    doc.on("data", chunk => chunks.push(chunk));
    doc.on("error", reject);
    doc.on("end", () => resolve(Buffer.concat(chunks)));

    const pageWidth = doc.page.width;
    const left = doc.page.margins.left;
    const right = doc.page.width - doc.page.margins.right;

    const headerTopY = doc.page.margins.top;
    let headerBottomY = headerTopY;

    // Logo (opcional)
    try {
      if (LOGO_URL) {
        const logoBuffer = await fetchBuffer(LOGO_URL);
        const logoWidth = 70;
        const logoX = left;
        const logoY = headerTopY;
        doc.image(logoBuffer, logoX, logoY, { width: logoWidth });
        headerBottomY = Math.max(headerBottomY, logoY + logoWidth * 0.9);
      }
    } catch (e) {
      // segue sem logo
    }

    // Títulos (centralizados)
    doc.font("Helvetica-Bold").fontSize(16)
      .text("PMDF/DPTS - COMISSÃO PCS", 0, headerTopY, { align: "center" });
    doc.moveDown(0.3);
    doc.font("Helvetica").fontSize(12)
      .text(titulo, { align: "center" });
    headerBottomY = Math.max(headerBottomY, doc.y);

    // QR Code (opcional)
    if (reportUrl) {
      try {
        const qrDataUrl = await QRCode.toDataURL(reportUrl, { margin: 1, scale: 4 });
        const qrBase64 = qrDataUrl.split(",")[1];
        const qrBuffer = Buffer.from(qrBase64, "base64");
        const qrSize = 100;
        const qrX = right - qrSize;
        const qrY = headerTopY;
        doc.image(qrBuffer, qrX, qrY, { width: qrSize, height: qrSize });
        doc.font("Helvetica").fontSize(8)
          .text("Acesse o relatório", qrX, qrY + qrSize + 4, { width: qrSize, align: "center" });
        headerBottomY = Math.max(headerBottomY, qrY + qrSize + 20);
      } catch (e) {
        // sem QR
      }
    }

    // Linha e espaçamento
    const sepY = Math.max(headerBottomY + 8, headerTopY + 60);
    doc.moveTo(left, sepY)
       .lineTo(pageWidth - doc.page.margins.right, sepY)
       .stroke();

    // Piso mínimo para início do conteúdo
    const MIN_CONTENT_TOP = headerTopY + 160;
    let contentStartY = Math.max(sepY + 20, MIN_CONTENT_TOP);
    doc.y = contentStartY;
    let y = doc.y;

    // ====== Dados básicos ======
    y = drawLabelValue(doc, "CPR:", patrimonio.DS_CPR || String(patrimonio.ID_CPR), 50, y);
    y = drawLabelValue(doc, "BPM:", patrimonio.DS_BPM || String(patrimonio.ID_BPM), 50, y);
    y = drawLabelValue(doc, "PCS:", patrimonio.DS_PCS || String(patrimonio.ID_PCS), 50, y);
    y = drawLabelValue(doc, "N. Tombamento Módulo:", patrimonio.NU_TOMBAMENTO_MODULO || String(patrimonio.NU_TOMBAMENTO_MODULO), 50, y);
    y = drawLabelValue(doc, "N. Tombamento Torre:", patrimonio.NU_TOMBAMENTO_TORRE || String(patrimonio.NU_TOMBAMENTO_TORRE), 50, y);
    y = drawLabelValue(doc, "PCS:", patrimonio.DS_PCS || String(patrimonio.ID_PCS), 50, y);
    y = drawLabelValue(doc, "Localização (URL):", patrimonio.TX_LOCALIZACAO, 50, y);
    y = drawLabelValue(doc, "Endereço:", patrimonio.TX_ENDERECO, 50, y); // <= NOVO CAMPO NO RELATÓRIO
    y = drawLabelValue(doc, "Base localizada:", patrimonio.ST_BASE_LOCALIZADO ? "Sim" : "Não", 50, y);
    y = drawLabelValue(doc, "Módulo localizado:", patrimonio.ST_MODULO_LOCALIZADO ? "Sim" : "Não", 50, y);
    y = drawLabelValue(doc, "Torre localizada:", patrimonio.ST_TORRE_LOCALIZADO ? "Sim" : "Não", 50, y);
    y = drawLabelValue(doc, "Observações:", patrimonio.TX_OBSERVACAO || String(patrimonio.TX_OBSERVACAO), 50, y);

    // ====== Galeria de imagens: 2 por página ======
    if (arquivos && arquivos.length) {
      const imagens = arquivos
        .filter(a => (a.TP_ARQUIVO || "").startsWith("image"))
        .map(a => a.URL_ARQUIVO_BUCKET);

      if (imagens.length) {
        await renderImagesTwoPerPage(doc, imagens);
      }
    }

    // Rodapé
    doc.moveTo(doc.page.margins.left, doc.page.height - doc.page.margins.bottom - 20)
      .lineTo(doc.page.width - doc.page.margins.right, doc.page.height - doc.page.margins.bottom - 20).stroke();
    doc.font("Helvetica").fontSize(8).text(`Gerado em: ${new Date().toLocaleString("pt-BR")}`, { align: "right" });

    doc.end();
  });
}

// -------------------- ENDPOINTS -------------------- //


app.get("/qtdCPRsVisitados", async (req, res) => {
  let connection;
  try {
    connection = await pool.getConnection();
    const [rows] = await connection.execute(`SELECT DISTINCT ID_CPR AS CPR_VISITADOS FROM TB_PATRIMONIO`);
    sendResponse(res, true, "Lista de CPRs já visitados carregada com sucesso.", "success", rows);
  } catch (error) {
    console.error("Erro ao listar CPRs Visitados:", error);
    sendResponse(res, false, "Erro ao carregar CPRs já visitados.", "error", null, 500);
  } finally {
    if (connection) connection.release();
  }
});

app.get("/qtdBPMsVisitados", async (req, res) => {
  let connection;
  try {
    connection = await pool.getConnection();
    const [rows] = await connection.execute(`SELECT DISTINCT PAT.ID_BPM, BPM.DS_BPM FROM TB_PATRIMONIO PAT, TB_BPM BPM WHERE PAT.ID_BPM = BPM.ID_BPM`);
    sendResponse(res, true, "Lista de BPMs já visitados carregada com sucesso.", "success", rows);
  } catch (error) {
    console.error("Erro ao listar BPMs Visitados:", error);
    sendResponse(res, false, "Erro ao carregar BPMs já visitados.", "error", null, 500);
  } finally {
    if (connection) connection.release();
  }
});

app.get("/qtdPCSsRegistrados", async (req, res) => {
  let connection;
  try {
    connection = await pool.getConnection();
    const [rows] = await connection.execute(`
        SELECT DISTINCT PAT.ID_CPR, CPR.DS_CPR, PAT.ID_BPM, BPM.DS_BPM, PAT.ID_PCS, PCS.DS_PCS 
        FROM TB_PATRIMONIO PAT, TB_PCS PCS, TB_CPR CPR, TB_BPM BPM
        WHERE 
        PAT.ID_CPR = CPR.ID_CPR AND
        PAT.ID_BPM = BPM.ID_BPM AND
        PAT.ID_PCS = PCS.ID_PCS
        ORDER BY PAT.ID_CPR, PAT.ID_BPM, PAT.ID_PCS
      `);
    sendResponse(res, true, "Lista de PCSs já registrados carregada com sucesso.", "success", rows);
  } catch (error) {
    console.error("Erro ao listar PCSs já registrados:", error);
    sendResponse(res, false, "Erro ao carregar PCSs já registrados.", "error", null, 500);
  } finally {
    if (connection) connection.release();
  }
});

app.get("/qtdBasesLocalizadas", async (req, res) => {
  let connection;
  try {
    connection = await pool.getConnection();
    const [rows] = await connection.execute(`SELECT ID_CPR, ID_BPM, ID_PCS, ST_BASE_LOCALIZADO FROM TB_PATRIMONIO WHERE ST_BASE_LOCALIZADO = 1`);
    sendResponse(res, true, "Lista de Bases localizadas carregada com sucesso.", "success", rows);
  } catch (error) {
    console.error("Erro ao listar Bases Localizadas:", error);
    sendResponse(res, false, "Erro ao carregar Bases Localizadas.", "error", null, 500);
  } finally {
    if (connection) connection.release();
  }
});

app.get("/qtdModulosLocalizados", async (req, res) => {
  let connection;
  try {
    connection = await pool.getConnection();
    const [rows] = await connection.execute(`SELECT ID_CPR, ID_BPM, ID_PCS, ST_MODULO_LOCALIZADO FROM TB_PATRIMONIO WHERE ST_MODULO_LOCALIZADO = 1`);
    sendResponse(res, true, "Lista de Modulos localizadas carregada com sucesso.", "success", rows);
  } catch (error) {
    console.error("Erro ao listar Modulos Localizados:", error);
    sendResponse(res, false, "Erro ao carregar Modulos localizados.", "error", null, 500);
  } finally {
    if (connection) connection.release();
  }
});

app.get("/qtdTorresLocalizadas", async (req, res) => {
  let connection;
  try {
    connection = await pool.getConnection();
    const [rows] = await connection.execute(`SELECT ID_CPR, ID_BPM, ID_PCS, ST_TORRE_LOCALIZADO FROM TB_PATRIMONIO WHERE ST_TORRE_LOCALIZADO = 1`);
    sendResponse(res, true, "Lista de Torres localizadas carregada com sucesso.", "success", rows);
  } catch (error) {
    console.error("Erro ao listar Torres Localizados:", error);
    sendResponse(res, false, "Erro ao carregar Torres localizados.", "error", null, 500);
  } finally {
    if (connection) connection.release();
  }
});

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
    console.error("Erro ao listar PCSs:", error);
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
      ORDER BY c.ID_CPR, b.ID_BPM
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
      `SELECT ID_PATRIMONIO, TX_LOCALIZACAO, TX_ENDERECO, NU_TOMBAMENTO_MODULO, NU_TOMBAMENTO_TORRE, ST_MODULO_LOCALIZADO, ST_BASE_LOCALIZADO, ST_TORRE_LOCALIZADO, TX_OBSERVACAO
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
    ID_CPR, ID_BPM, ID_PCS, TX_LOCALIZACAO, TX_ENDERECO, NU_TOMBAMENTO_MODULO, NU_TOMBAMENTO_TORRE,
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
         SET TX_LOCALIZACAO=?, TX_ENDERECO=?, NU_TOMBAMENTO_MODULO=?, NU_TOMBAMENTO_TORRE=?, ST_MODULO_LOCALIZADO=?, 
         ST_BASE_LOCALIZADO=?, ST_TORRE_LOCALIZADO=?, TX_OBSERVACAO=?
         WHERE ID_PATRIMONIO=?`,
        [TX_LOCALIZACAO, TX_ENDERECO, NU_TOMBAMENTO_MODULO, NU_TOMBAMENTO_TORRE, ST_MODULO_LOCALIZADO, ST_BASE_LOCALIZADO, ST_TORRE_LOCALIZADO, TX_OBSERVACAO, patrimonioId]
      );
      msg = "Patrimônio atualizado com sucesso!";
    } else {
      const [result] = await connection.execute(
        `INSERT INTO TB_PATRIMONIO (ID_CPR, ID_BPM, ID_PCS, TX_LOCALIZACAO, TX_ENDERECO, NU_TOMBAMENTO_MODULO, NU_TOMBAMENTO_TORRE, ST_MODULO_LOCALIZADO, ST_BASE_LOCALIZADO, ST_TORRE_LOCALIZADO, TX_OBSERVACAO)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [ID_CPR, ID_BPM, ID_PCS, TX_LOCALIZACAO, TX_ENDERECO, NU_TOMBAMENTO_MODULO, NU_TOMBAMENTO_TORRE, ST_MODULO_LOCALIZADO, ST_BASE_LOCALIZADO, ST_TORRE_LOCALIZADO, TX_OBSERVACAO]
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

// ========================= ENDPOINT: PDF (chave fixa) =========================
// POST /gerar-relatorio-patrimonio?id=<ID_PATRIMONIO>
app.post("/gerar-relatorio-patrimonio", async (req, res) => {
  const { id } = req.query;
  if (!id) return sendResponse(res, false, 'Parâmetro "id" é obrigatório.', "warning", null, 400);

  let connection;
  try {
    connection = await pool.getConnection();

    // Busca patrimônio + nomes (DS_CPR/BPM/PCS)
    const [rows] = await connection.execute(`
      SELECT p.*, c.DS_CPR, b.DS_BPM, s.DS_PCS
      FROM TB_PATRIMONIO p
      LEFT JOIN TB_CPR c ON p.ID_CPR = c.ID_CPR
      LEFT JOIN TB_BPM b ON p.ID_BPM = b.ID_BPM
      LEFT JOIN TB_PCS s ON p.ID_PCS = s.ID_PCS
      WHERE p.ID_PATRIMONIO = ?
      LIMIT 1
    `, [id]);

    if (!rows.length) {
      return sendResponse(res, false, "Patrimônio não encontrado.", "warning", null, 404);
    }

    const patrimonio = rows[0];

    // Busca arquivos
    const [arquivos] = await connection.execute(`
      SELECT ID_ARQUIVO, NM_ARQUIVO, URL_ARQUIVO_BUCKET, TP_ARQUIVO, TAM_ARQUIVO
      FROM TB_ARQUIVO
      WHERE ID_PATRIMONIO = ?
      ORDER BY DT_UPLOAD_ARQUIVO ASC
    `, [id]);

    // Chave fixa (sempre sobrescreve)
    const reportKey = `reports/${id}.pdf`;
    const reportPublicUrl = `https://${BUCKET_NAME}.s3.amazonaws.com/${reportKey}`;

    // Gera PDF em memória
    const pdfBuffer = await makePatrimonioPDF({
      patrimonio,
      arquivos,
      reportUrl: reportPublicUrl,
      titulo: "Relatório de Patrimônio"
    });

    // Envia pro S3 (público) — sobrescreve o mesmo objeto
    await s3.send(new PutObjectCommand({
      Bucket: BUCKET_NAME,
      Key: reportKey,
      Body: pdfBuffer,
      ContentType: "application/pdf",
      ACL: "public-read",
      CacheControl: "no-cache"
    }));

    return sendResponse(res, true, "Relatório gerado com sucesso.", "success", { url: reportPublicUrl });
  } catch (error) {
    console.error("Erro ao gerar relatório:", error);
    return sendResponse(res, false, "Erro interno ao gerar relatório.", "error", null, 500);
  } finally {
    if (connection) connection.release();
  }
});
// ============================================================================

module.exports.handler = serverless(app);
