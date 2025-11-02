const express = require('express');
// Importante: Usamos mysql2/promise para manejar consultas asíncronas con await/async.
const mysql = require('mysql2/promise');
const path = require('path');
const cors = require('cors');
const jwt = require('jsonwebtoken');
const app = express();
const port = 3000; // Puedes cambiar esto a 4000

const JWT_SECRET = 'admin123';

// 💡 Nueva función: Calcula el precio de venta a partir del costo y el margen.
const calculatePrecio = (costo, margen) => {
    // Aseguramos que los valores sean numéricos y no nulos.
    if (costo === null || margen === null || isNaN(parseFloat(costo)) || isNaN(parseFloat(margen))) {
        return null;
    }
    const c = parseFloat(costo);
    const m = parseFloat(margen);
    // Margen como porcentaje (e.g., 20 para 20%)
    return c * (1 + m / 100);
};
// Configuración de la conexión a la base de datos Aiven
const dbConfig = {
    // Usamos el host, puerto y credenciales de Aiven.
    host: process.env.DB_HOST,
    user: process.env.DB_USER,
    password: process.env.DB_PASSWORD,
    database: process.env.DB_NAME,
    port: parseInt(process.env.DB_PORT, 10), // Aseguramos que el puerto sea un número
    ssl: {
        // Necesario para Aiven. En producción se recomienda usar el CA file.
        // rejectUnauthorized: false se usa en desarrollo si no tienes el archivo CA.
        rejectUnauthorized: false
    },
    waitForConnections: true,
    connectionLimit: 10,
    queueLimit: 0
};

// Crear el Pool de Conexiones (reemplaza a db.createConnection)
const pool = mysql.createPool(dbConfig);

// Verificar la conexión inicial a la base de datos
pool.getConnection()
    .then(connection => {
        console.log('✅ Conectado al Pool de la base de datos Aiven.');
        connection.release(); // Liberar la conexión
    })
    .catch(err => {
        console.error('❌ ERROR CRÍTICO: No se pudo conectar a la base de datos Aiven:', err.message);
        // Es mejor terminar la aplicación si la DB es inaccesible
        process.exit(1);
    });


// Middleware para habilitar CORS y procesar JSON
app.use(cors({
    origin: '*',
    methods: 'GET,HEAD,PUT,PATCH,POST,DELETE',
    allowedHeaders: 'Content-Type, x-auth-token',
    exposedHeaders: 'x-auth-token'
}));

app.use(express.json());

// Middleware para servir archivos estáticos (imágenes)
app.use(express.static('public'));

// Middleware de seguridad para proteger las rutas de administración
function authAdmin(req, res, next) {
    // ... (El código de authAdmin sigue igual)
    const token = req.headers['x-auth-token'];
    if (!token) {
        return res.status(401).send({ message: 'Acceso denegado. No hay token proporcionado.' });
    }
    try {
        const decoded = jwt.verify(token, JWT_SECRET);
        req.user = decoded;
        next();
    } catch (ex) {
        return res.status(401).send({ message: 'Token inválido o expirado.' });
    }
}

// -----------------------------------------------------------
// FUNCIONES Y RUTAS DEL CATÁLOGO
// -----------------------------------------------------------

// Función de mapeo para transformar la fila de SQL a formato JS con array de imágenes
function mapProducto(row) {
    if (!row) return null;
    const producto = {
        ...row,
        imagenes: row.imagenes_urls
            ? row.imagenes_urls.split(',')
                .map(url => url.replace(/\\/g, '/'))
            : []
    };
    delete producto.imagenes_urls;
    return producto;
}
// 1. GET todos los productos (PÚBLICA)
app.get('/api/catalogoartic', async (req, res) => {
    const query = `
        SELECT a.*, GROUP_CONCAT(i.url ORDER BY i.orden SEPARATOR ',') as imagenes_urls
        FROM catalogoartic a             
        LEFT JOIN producto_imagenes i ON a.id = i.producto_id 
        GROUP BY a.id
    `;
    try {
        // Ejecutar consulta usando el pool y await
        const [results] = await pool.query(query); // pool.query devuelve [rows, fields]

        const articulos = results.map(mapProducto);
        res.send(articulos);

    } catch (err) {
        console.error('Error FATAL en la consulta de artículos (MySQL):', err.message);
        console.error('Consulta SQL fallida:', query);
        // Devolver un error 500
        return res.status(500).send({ message: 'Error interno del servidor al consultar el catálogo. Por favor, revise la consola del servidor para ver el error de MySQL.' });
    }
});

// 2. GET producto por ID (PÚBLICA)
app.get('/api/catalogoartic/:id', async (req, res) => {
    const id = parseInt(req.params.id);
    const query = `
        SELECT a.*, GROUP_CONCAT(i.url ORDER BY i.orden SEPARATOR ',') as imagenes_urls
       FROM catalogoartic a            
        LEFT JOIN producto_imagenes i ON a.id = i.producto_id 
        WHERE a.id = ?
        GROUP BY a.id
    `;
    try {
        const [results] = await pool.query(query, [id]);

        if (results.length === 0) {
            return res.status(404).send({ message: 'Producto no encontrado.' });
        }

        const producto = mapProducto(results[0]);
        res.send(producto);

    } catch (err) {
        console.error('Error al obtener artículo por ID:', err);
        return res.status(500).send({ message: 'Error interno del servidor.' });
    }
});

// 3. POST agregar producto (Insertar en catalogoartic y producto_imagenes)
app.post('/api/catalogoartic', authAdmin, async (req, res) => {
    const { nombre, descripcion, unidades, costo, margen, rubro, imagenes } = req.body;

    // 💡 CALCULO DE PRECIO: Usando el nuevo helper
    const precio = calculatePrecio(costo, margen);

    // Creamos la transacción usando una conexión del pool
    let connection;
    try {
        // 1. Obtener conexión
        connection = await pool.getConnection();
        await connection.beginTransaction(); // Iniciar la transacción

        // 2. Insertar el artículo principal
        const articuloQuery = 'INSERT INTO catalogoartic (nombre, descripcion, unidades_disponibles, costo, margen, rubro, precio) VALUES (?, ?, ?, ?, ?, ?, ?)';
        // El resultado es un objeto con la propiedad insertId
        const [result] = await connection.query(articuloQuery, [nombre, descripcion, unidades, costo, margen, rubro, precio]);
        const articuloId = result.insertId;

        // 3. Insertar las imágenes (si existen)
        if (imagenes && imagenes.length > 0) {
            // Preparamos los valores para el INSERT múltiple
            const imagenValues = imagenes.map((url, index) => [articuloId, url.replace(/\\/g, '/'), index + 1]);
            const imagenQuery = 'INSERT INTO producto_imagenes (producto_id, url, orden) VALUES ?';

            // Usamos un query especial para INSERT VALUES (?)
            await connection.query(imagenQuery, [imagenValues]);
        }

        await connection.commit(); // Confirmar la transacción

        // 4. Respuesta final
        res.status(201).send({ id: articuloId, message: 'Producto creado con éxito.' });

    } catch (err) {
        if (connection) {
            await connection.rollback(); // Deshacer la transacción en caso de error
        }
        console.error('Error FATAL en la creación del producto (Transacción):', err);
        return res.status(500).send({ message: 'Error interno del servidor al crear el artículo/imágenes.' });

    } finally {
        if (connection) {
            connection.release(); // Liberar la conexión al pool
        }
    }
});
// 4. PUT actualizar producto (Actualizar catalogoartic y (reemplazar) producto_imagenes)
app.put('/api/catalogoartic/:id', authAdmin, async (req, res) => {
    const id = parseInt(req.params.id);
    const { nombre, descripcion, unidades, costo, margen, rubro, imagenes } = req.body;

    // 💡 RE-CALCULO DE PRECIO: Usando el nuevo helper
    const precio = calculatePrecio(costo, margen);

    let connection;
    try {
        connection = await pool.getConnection();
        await connection.beginTransaction(); // Iniciar la transacción

        // 1. Actualizar el artículo principal
        const articuloQuery = 'UPDATE catalogoartic SET nombre = ?, descripcion = ?, unidades_disponibles = ?, costo = ?, margen = ?, rubro = ?, precio = ? WHERE id = ?';
        const [result] = await connection.query(articuloQuery, [nombre, descripcion, unidades, costo, margen, rubro, precio, id]);

        if (result.affectedRows === 0) {
            await connection.rollback(); // Si no se actualizó, revertir
            return res.status(404).send({ message: 'Producto no encontrado para actualizar.' });
        }

        // 2. Reemplazar las imágenes: a) Borrar las viejas
        const deleteQuery = 'DELETE FROM producto_imagenes WHERE producto_id = ?';
        await connection.query(deleteQuery, [id]);

        // 3. Reemplazar las imágenes: b) Insertar las nuevas
        if (imagenes && imagenes.length > 0) {
            const imagenValues = imagenes.map((url, index) => [id, url.replace(/\\/g, '/'), index + 1]);
            const insertQuery = 'INSERT INTO producto_imagenes (producto_id, url, orden) VALUES ?';

            await connection.query(insertQuery, [imagenValues]);
        }

        await connection.commit(); // Confirmar la transacción

        // 4. Respuesta final
        res.status(200).send({ id: id, message: 'Producto y/o imágenes actualizados con éxito.' });

    } catch (err) {
        if (connection) {
            await connection.rollback(); // Deshacer la transacción en caso de error
        }
        console.error('Error FATAL en la actualización del producto (Transacción):', err);
        return res.status(500).send({ message: 'Error interno del servidor al actualizar el artículo.' });

    } finally {
        if (connection) {
            connection.release(); // Liberar la conexión al pool
        }
    }
});

// 5. DELETE eliminar producto
app.delete('/api/catalogoartic/:id',authAdmin, async (req, res) => {

    const id = parseInt(req.params.id);

    let connection;
    try {
        connection = await pool.getConnection();
        await connection.beginTransaction(); // Iniciar la transacción

        // 1. Eliminar imágenes relacionadas (opcional si tienes ON DELETE CASCADE, pero seguro)
        const deleteImagesQuery = 'DELETE FROM producto_imagenes WHERE producto_id = ?';
        await connection.query(deleteImagesQuery, [id]);

        // 2. Eliminar el artículo principal
        const deleteArticleQuery = 'DELETE FROM catalogoartic WHERE id = ?';
        const [result] = await connection.query(deleteArticleQuery, [id]);

        if (result.affectedRows === 0) {
            await connection.rollback(); // Si no se encontró, revertir
            return res.status(404).send({ message: 'Producto no encontrado para eliminar.' });
        }

        await connection.commit(); // Confirmar la transacción

        res.status(200).send({ message: 'Producto eliminado correctamente.' });

    } catch (err) {
        if (connection) {
            await connection.rollback(); // Deshacer la transacción en caso de error
        }
        console.error('Error FATAL al eliminar artículo (Transacción):', err);
        return res.status(500).send({ message: 'Error interno del servidor al eliminar artículo.' });

    } finally {
        if (connection) {
            connection.release(); // Liberar la conexión al pool
        }
    }
});

// -----------------------------------------------------------
// RUTA DE LOGIN (PÚBLICA)
// -----------------------------------------------------------

// INICIO DEL SERVIDOR

app.listen(port, () => {
    console.log(`Servidor de API ejecutándose en http://localhost:${port}`);
}); 