param([Parameter(Mandatory)][string]$Executable, [Parameter(Mandatory)][string]$IconFile, [ValidateSet(1, 2)][int]$Group = 1)
$ErrorActionPreference = 'Stop'

if (-not ('MarkCraft.IconResources' -as [type])) {
    Add-Type @"
using System;
using System.ComponentModel;
using System.IO;
using System.Runtime.InteropServices;
namespace MarkCraft {
    public static class IconResources {
        [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
        static extern IntPtr BeginUpdateResource(string file, bool deleteExisting);
        [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
        static extern bool UpdateResource(IntPtr handle, IntPtr type, IntPtr id, ushort language, byte[] data, uint size);
        [DllImport("kernel32.dll", SetLastError = true, CharSet = CharSet.Unicode)]
        static extern bool EndUpdateResource(IntPtr handle, bool discard);
        static void Set(IntPtr handle, int type, int id, byte[] data) {
            if (!UpdateResource(handle, (IntPtr)type, (IntPtr)id, 0, data, (uint)data.Length))
                throw new Win32Exception();
        }
        public static void Embed(string exe, string ico, int groupId) {
            byte[] data = File.ReadAllBytes(ico);
            if (data.Length < 6 || BitConverter.ToUInt16(data, 2) != 1) throw new InvalidDataException("Invalid ICO");
            int count = BitConverter.ToUInt16(data, 4);
            if (count < 1 || count > 256 || data.Length < 6 + 16 * count) throw new InvalidDataException("Invalid ICO directory");
            byte[] group = new byte[6 + count * 14];
            Buffer.BlockCopy(data, 0, group, 0, 6);
            IntPtr handle = BeginUpdateResource(exe, false);
            if (handle == IntPtr.Zero) throw new Win32Exception();
            bool commit = false;
            try {
                for (int i = 0; i < count; i++) {
                    int entry = 6 + i * 16, slot = 6 + i * 14;
                    int size = BitConverter.ToInt32(data, entry + 8), offset = BitConverter.ToInt32(data, entry + 12);
                    if (size <= 0 || offset < 6 + 16 * count || offset > data.Length - size) throw new InvalidDataException("Invalid ICO image");
                    byte[] image = new byte[size];
                    Buffer.BlockCopy(data, offset, image, 0, size);
                    int imageId = (groupId - 1) * 256 + i + 1;
                    Set(handle, 3, imageId, image);
                    Buffer.BlockCopy(data, entry, group, slot, 12);
                    Buffer.BlockCopy(BitConverter.GetBytes((ushort)imageId), 0, group, slot + 12, 2);
                }
                Set(handle, 14, groupId, group);
                commit = true;
            } finally {
                if (!EndUpdateResource(handle, !commit)) throw new Win32Exception();
            }
        }
    }
}
"@
}
[MarkCraft.IconResources]::Embed((Get-Item -LiteralPath $Executable).FullName, (Get-Item -LiteralPath $IconFile).FullName, $Group)
