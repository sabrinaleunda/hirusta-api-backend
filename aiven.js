import express from 'express';
// Importamos createPool directamente desde mysql2/promise
import { createPool } from 'mysql2/promise'; 
import cors from 'cors';

// =======================================================
// 1. CONFIGURACIÓN DEL SERVIDOR Y LA BASE DE DATOS
// =======================================================

const app = express();
const PORT = 3000;

// Configuración de la base de datos (Usando tus variables de entorno o valores por defecto)
const dbConfig = {
    host: process.env.DB_HOST,
    user: process.env.DB_USER,
    password: process.env.DB_PASSWORD,
    database: process.env.DB_NAME, 
    port: process.env.DB_PORT, // Reemplaza con tu puerto real de Aiven
    ssl: {
        // En producción, se recomienda usar un archivo CA real. 
        // rejectUnauthorized: false se usa a menudo en desarrollo para simplificar.
        rejectUnauthorized: false
    },
    // Otras configuraciones del Pool de Conexiones
    waitForConnections: true,
    connectionLimit: 10,
    queueLimit: 0
};

let pool; // La variable del pool debe ser global o accesible por las rutas

// =======================================================
// 2. MIDDLEWARE (Debe ir antes de las rutas)
// =======================================================

app.use(express.json());

// Configuración CORS
app.use(cors({
    // Permite solicitudes de tu dominio (importante incluir http://)
    origin: 'http://hirustafibrofacil.com.ar', 
    methods: ['GET', 'POST', 'PUT', 'DELETE'],
    allowedHeaders: ['Content-Type', 'Authorization']
}));

app.use(express.static('public'));
// =======================================================
// 3. CONEXIÓN A LA BASE DE DATOS
// =======================================================

async function initializeDatabase() {
    try {
        pool = createPool(dbConfig);
        // Intentar una conexión para verificar que todo esté OK
        await pool.getConnection(); 
        console.log("✅ Conexión a la base de datos Aiven establecida correctamente.");
    } catch (error) {
        console.error("❌ ERROR: No se pudo conectar a la base de datos. Verifica la configuración (Host, Puerto, Credenciales, SSL).");
        console.error(error);
        // Detener la ejecución si no podemos conectar a la BD
        process.exit(1); 
    }
}

// =======================================================
// 4. RUTAS DE LA API
// =======================================================

app.get('/', (req, res) => {
    res.send('Servidor Node.js con Aiven (MySQL) ejecutándose.');
});

// Ruta principal para obtener el catálogo, incluyendo la URL de la imagen principal
app.get('/api/catalogoartic', async (req, res) => {
    console.log('Solicitud recibida para /api/catalogoartic (con imágenes)');
    try {
        // *** CONSULTA SQL CON SUBCONSULTA PARA OBTENER LA IMAGEN PRINCIPAL ***
        // Esta consulta es eficiente para obtener la primera imagen por producto.
        const sqlQuery = `
            SELECT 
                a.id, 
                a.nombre, 
                a.descripcion, 
                a.precio, 
                a.rubro,
                -- Subconsulta para obtener la URL de la primera imagen asociada
                (
                    SELECT url 
                    FROM producto_imagenes pi 
                    WHERE pi.id_producto = a.id 
                    ORDER BY pi.orden ASC 
                    LIMIT 1
                ) AS imagen_url
            FROM 
                catalogoartic a
            LIMIT 
                50;
        `;
        
        // Ejecutar la consulta en el pool de conexiones
        const [rows] = await pool.execute(sqlQuery); 
        
        console.log(`Consulta SQL ejecutada con éxito. Filas encontradas: ${rows.length}`);
        
        // Mapear y sanear los datos antes de enviarlos
        const productos = rows.map(row => ({
            id: row.id,
            nombre: row.nombre,
            descripcion: row.descripcion,
            precio: parseFloat(row.precio),
            rubro: row.rubro,
            imagen_url: row.imagen_url || null // Si no hay URL, enviamos null
        }));

        res.status(200).json(productos);

    } catch (error) {
        console.error("Error al ejecutar la consulta del catálogo:", error);
        res.status(500).json({ 
            message: "Error interno del servidor al cargar el catálogo con imágenes.",
            error_details: error.message // Exponemos el mensaje de error para debugging
        });
    }
});

// =======================================================
// 5. INICIO DEL SERVIDOR
// =======================================================

// 1. Inicializamos la base de datos.
// 2. Si es exitoso, iniciamos el servidor Express.
initializeDatabase().then(() => {
    app.listen(PORT, () => {
        console.log(`🚀 Servidor de Backend corriendo en http://localhost:${PORT}`);
        console.log(`🔗 ¡Prueba la conexión y el CORS!: http://localhost:${PORT}/api/catalogoartic`);
    });
}).catch(err => {
    // Esto se ejecutará si initializeDatabase falla.
    console.error("Fallo catastrófico al iniciar el servidor.", err);
});