package io.github.zhenyufu039.playtime;

import java.io.ByteArrayOutputStream;
import java.io.File;
import java.io.FileOutputStream;
import java.io.IOException;
import java.io.InputStream;
import java.io.OutputStream;
import java.nio.charset.StandardCharsets;

/** Installs trusted APK assets. A matching marker is written only after every file was copied. */
final class RuntimeBundle {
    interface Assets {
        String[] list(String path) throws IOException;
        InputStream open(String path) throws IOException;
    }

    static void install(Assets assets, File runtime) throws IOException {
        String stamp = read(assets.open("playtime/BUILD_STAMP"));
        File marker = new File(runtime, "BUILD_STAMP");
        if (marker.isFile() && stamp.equals(read(new java.io.FileInputStream(marker)))) return;
        remove(runtime);
        copy(assets, "playtime", runtime);
        // On failure or process death before this point, the next launch retries the whole bundle.
        try (OutputStream out = new FileOutputStream(marker)) {
            out.write(stamp.getBytes(StandardCharsets.UTF_8));
        }
    }

    private static void copy(Assets assets, String path, File target) throws IOException {
        if (path.equals("playtime/BUILD_STAMP")) return;
        String[] children = assets.list(path);
        if (children != null && children.length > 0) {
            if (!target.isDirectory() && !target.mkdirs()) throw new IOException("Cannot create " + target);
            for (String child : children) copy(assets, path + "/" + child, new File(target, child));
        } else {
            try (InputStream in = assets.open(path); OutputStream out = new FileOutputStream(target)) {
                byte[] buffer = new byte[64 * 1024];
                for (int n; (n = in.read(buffer)) != -1; ) out.write(buffer, 0, n);
            }
        }
    }

    private static void remove(File file) throws IOException {
        File[] children = file.listFiles();
        if (children != null) for (File child : children) remove(child);
        if (file.exists() && !file.delete()) throw new IOException("Cannot replace " + file);
    }

    private static String read(InputStream input) throws IOException {
        try (InputStream stream = input) {
            ByteArrayOutputStream bytes = new ByteArrayOutputStream();
            byte[] buffer = new byte[4096];
            for (int n; (n = stream.read(buffer)) != -1; ) bytes.write(buffer, 0, n);
            return new String(bytes.toByteArray(), StandardCharsets.UTF_8).trim();
        }
    }
}
