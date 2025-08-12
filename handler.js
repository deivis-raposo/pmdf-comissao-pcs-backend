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
  doc.font("Helvetica-Bold").fontSize(10).text(label, x, y, { width: labelWidth });
  doc.font("Helvetica").fontSize(10).text(value ?? "-", x + labelWidth + 6, y);
  return y + lineHeight;
}

async function fetchBuffer(url) {
  const res = await axiosHttp.get(url, { responseType: "arraybuffer" });
  return Buffer.from(res.data);
}

// Renderiza imagens 2 por página A4 (retrato), cada uma metade da página
async function renderImagesTwoPerPage(doc, imagensUrls) {
  if (!imagensUrls.length) return;

  const pageWidth = doc.page.width;
  const pageHeight = doc.page.height;
  const left = doc.page.margins.left;
  const right = doc.page.width - doc.page.margins.right;
  const top = doc.page.margins.top;
  const bottom = doc.page.height - doc.page.margins.bottom;

  const contentWidth = right - left;

  // Título apenas na primeira página de anexos
  let isFirstImagesPage = true;

  // Configurações de layout
  const gapBetweenSlots = 18; // espaço vertical entre as duas metades
  const titleGap = 10;        // espaço após o título "Anexos (imagens)"
  const slotTopPadding = 8;   // padding interno superior de cada metade
  const slotBottomPadding = 8;// padding interno inferior de cada metade
  const sidePadding = 0;      // padding horizontal (se quiser reduzir um pouco a largura)

  // Função para desenhar uma imagem dentro de um "slot" (metade superior ou inferior)
  async function drawImageInSlot(imgUrl, slotTopY, slotBottomY) {
    const availWidth = contentWidth - 2 * sidePadding;
    const availHeight = (slotBottomY - slotTopY) - (slotTopPadding + slotBottomPadding);

    // Baixa imagem
    const imgBuffer = await fetchBuffer(imgUrl);

    // PDFKit detecta dimensões internamente; vamos ajustar por fit
    // Para centralizar manualmente, precisamos testar escala.
    // Estratégia: desenhar com fit=[availWidth, availHeight] e calcular posição central.
    // Porém o método image() com 'fit' posiciona pelo x,y dados como canto superior esquerdo;
    // para centralizar, vamos estimar o tamanho final:
    // Não há retorno do tamanho final na API, então assumimos que a imagem vai caber inteira no retângulo.
    // Vamos centralizar pela área disponível:
    const x = left + sidePadding;
    const y = slotTopY + slotTopPadding;

    // Desenha dentro do retângulo mantendo proporção
    doc.image(imgBuffer, x, y, { fit: [availWidth, availHeight], align: 'center', valign: 'center' });
  }

  // Percorre imagens, 2 por página
  for (let i = 0; i < imagensUrls.length; i += 2) {
    // Nova página
    doc.addPage();

    let yCursor = top;

    if (isFirstImagesPage) {
      doc.font("Helvetica-Bold").fontSize(11).text("Anexos (imagens):", left, yCursor);
      yCursor = doc.y + titleGap;
      isFirstImagesPage = false;
    }

    // Calcula altura disponível para os dois slots
    const totalAvailHeight = bottom - yCursor;
    const slotHeight = (totalAvailHeight - gapBetweenSlots) / 2;

    // Slot 1 (metade superior)
    const slot1Top = yCursor;
    const slot1Bottom = slot1Top + slotHeight;

    // Slot 2 (metade inferior)
    const slot2Top = slot1Bottom + gapBetweenSlots;
    const slot2Bottom = slot2Top + slotHeight;

    // Imagem 1
    try {
      await drawImageInSlot(imagensUrls[i], slot1Top, slot1Bottom);
    } catch (_) {
      // ignora imagem com erro
    }

    // Imagem 2 (se existir)
    if (i + 1 < imagensUrls.length) {
      try {
        await drawImageInSlot(imagensUrls[i + 1], slot2Top, slot2Bottom);
      } catch (_) {
        // ignora imagem com erro
      }
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

    // ====== Cabeçalho com logo (opcional) ======
    const pageWidth = doc.page.width;
    const left = doc.page.margins.left;
    const right = doc.page.width - doc.page.margins.right;

    const headerTopY = doc.page.margins.top;
    let headerBottomY = headerTopY; // acompanhar até onde o cabeçalho vai

    // Logo (opcional)
    try {
      if (LOGO_URL) {
        const logoBuffer = await fetchBuffer(LOGO_URL);
        const logoWidth = 70; // ajuste se quiser maior/menor
        const logoX = left;
        const logoY = headerTopY;
        doc.image(logoBuffer, logoX, logoY, { width: logoWidth });
        headerBottomY = Math.max(headerBottomY, logoY + logoWidth * 0.9); // altura aproximada
      }
    } catch (e) {
      // Se falhar o download do logo, segue sem logo
    }

    // Títulos (centralizados)
    doc.font("Helvetica-Bold").fontSize(16)
      .text("PMDF/DPTS - COMISSÃO PCS", 0, headerTopY, { align: "center" });
    doc.moveDown(0.3);
    doc.font("Helvetica").fontSize(12)
      .text(titulo, { align: "center" });
    headerBottomY = Math.max(headerBottomY, doc.y);

    // QR Code (opcional) no topo direito
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
        // segue sem QR se der erro
      }
    }

    // Linha separadora e espaçamento maior para o conteúdo
    const sepY = Math.max(headerBottomY + 8, headerTopY + 60);
    doc.moveTo(left, sepY)
       .lineTo(pageWidth - doc.page.margins.right, sepY)
       .stroke();

    // 👉 Força o conteúdo a começar abaixo de um piso mínimo (ex.: 160px)
    const MIN_CONTENT_TOP = headerTopY + 160; // ajuste se quiser mais/menos espaço
    let contentStartY = Math.max(sepY + 20, MIN_CONTENT_TOP);
    doc.y = contentStartY;
    let y = doc.y;

    // ====== Dados básicos ======
    y = drawLabelValue(doc, "CPR:", patrimonio.DS_CPR || String(patrimonio.ID_CPR), 50, y);
    y = drawLabelValue(doc, "BPM:", patrimonio.DS_BPM || String(patrimonio.ID_BPM), 50, y);
    y = drawLabelValue(doc, "PCS:", patrimonio.DS_PCS || String(patrimonio.ID_PCS), 50, y);
    y = drawLabelValue(doc, "Localização:", patrimonio.TX_LOCALIZACAO, 50, y);
    y = drawLabelValue(doc, "Módulo localizado:", patrimonio.ST_MODULO_LOCALIZADO ? "Sim" : "Não", 50, y);
    y = drawLabelValue(doc, "Base localizada:", patrimonio.ST_BASE_LOCALIZADO ? "Sim" : "Não", 50, y);
    y = drawLabelValue(doc, "Torre localizada:", patrimonio.ST_TORRE_LOCALIZADO ? "Sim" : "Não", 50, y);

    // ====== Observações ======
    doc.moveDown(0.8);
    doc.font("Helvetica-Bold").fontSize(11).text("Observações:");
    doc.font("Helvetica").fontSize(10).text(patrimonio.TX_OBSERVACAO || "-", { align: "left" });
    doc.moveDown(0.6);

    // ====== Galeria de imagens: 2 por página ======
    if (arquivos && arquivos.length) {
      const imagens = arquivos
        .filter(a => (a.TP_ARQUIVO || "").startsWith("image"))
        .map(a => a.URL_ARQUIVO_BUCKET);

      if (imagens.length) {
        await renderImagesTwoPerPage(doc, imagens);
      }
    }

    // ====== Rodapé ======
    doc.moveTo(doc.page.margins.left, doc.page.height - doc.page.margins.bottom - 20)
      .lineTo(doc.page.width - doc.page.margins.right, doc.page.height - doc.page.margins.bottom - 20).stroke();
    doc.font("Helvetica").fontSize(8).text(`Gerado em: ${new Date().toLocaleString("pt-BR")}`, { align: "right" });

    doc.end();
  });
}

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
      ORDER BY c.ID_CPR
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
